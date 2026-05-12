use cucumber::when;

use crate::DaemonWorld;

#[when("the codex mock is scripted to succeed with full metrics")]
pub async fn script_codex_success_with_metrics(world: &mut DaemonWorld) {
    // Per the upstream schema (`codex-rs/exec/src/exec_events.rs`), a
    // successful stream has no `thread.completed` marker -- it simply
    // terminates after `turn.completed`. The `type` discriminator on items
    // is `type`, not `item_type`.
    let agent_message = r#"{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"codex-final-answer"} }"#;
    let turn_completed = r#"{"type":"turn.completed","usage":{"input_tokens":1500,"cached_input_tokens":200,"output_tokens":800,"reasoning_output_tokens":0} }"#;
    let builder = world
        .mock_response("codex-happy")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"thread.started","thread_id":"thr-codex-1"}"#)
        .with_stdout_line(r#"{"type":"turn.started"}"#)
        .with_stdout_line(agent_message)
        .with_stdout_line(turn_completed);
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to succeed without an agent_message")]
pub async fn script_codex_success_without_agent_message(world: &mut DaemonWorld) {
    // Stream just terminates after `thread.started` -- no `turn.completed`
    // so no usage is recorded, and no `item.completed` so no output. This
    // mirrors the pre-fix behaviour where the (non-existent) `thread.completed`
    // stood in as a stream terminator.
    let builder = world
        .mock_response("codex-no-message")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"thread.started","thread_id":"thr-codex-2"}"#);
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit three jsonl item events")]
pub async fn script_codex_three_item_events(world: &mut DaemonWorld) {
    let reasoning =
        r#"{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"thinking"} }"#;
    // CommandExecutionItem requires `command`, `aggregated_output`,
    // `exit_code`, `status` per upstream. Status is the snake_case form of
    // the CommandExecutionStatus enum.
    let command = r#"{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","exit_code":0,"status":"completed","aggregated_output":""} }"#;
    let agent_message = r#"{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"three-events-done"} }"#;
    let builder = world
        .mock_response("codex-three-events")
        .with_exit_code(0)
        .with_stdout_line(reasoning)
        .with_stdout_line(command)
        .with_stdout_line(agent_message);
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit an error event")]
pub async fn script_codex_emits_error_event(world: &mut DaemonWorld) {
    // Upstream `ThreadErrorEvent` shape: `{"type":"error","message":"..."}`.
    // There is no `thread.failed` event in the schema -- fatal stream errors
    // arrive on this top-level `error` event.
    let error_event = r#"{"type":"error","message":"codex-mock-thread-failure"}"#;
    let builder = world
        .mock_response("codex-error-event")
        .with_exit_code(1)
        .with_stdout_line(r#"{"type":"thread.started","thread_id":"thr-codex-fail"}"#)
        .with_stdout_line(error_event)
        .with_stderr_line("codex: thread failed");
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit a turn.failed event")]
pub async fn script_codex_emits_turn_failed(world: &mut DaemonWorld) {
    // Upstream `TurnFailedEvent` shape: `{"type":"turn.failed","error":{"message":"..."}}`.
    // Distinct from the flat top-level `error` event -- this one nests the
    // message inside an `error` object. Both should mark the step failed.
    let turn_failed = r#"{"type":"turn.failed","error":{"message":"codex-mock-turn-failure"} }"#;
    let builder = world
        .mock_response("codex-turn-failed")
        .with_exit_code(1)
        .with_stdout_line(r#"{"type":"thread.started","thread_id":"thr-codex-turnfail"}"#)
        .with_stdout_line(r#"{"type":"turn.started"}"#)
        .with_stdout_line(turn_failed);
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit a structured JSON agent_message")]
pub async fn script_codex_structured_json_agent_message(world: &mut DaemonWorld) {
    let text = r#"{\"verdict\":\"approved\",\"score\":0.92}"#;
    script_codex_agent_message_with_text(
        world,
        "codex-structured-ok",
        "thr-codex-structured",
        text,
    )
    .await;
}

#[when("the codex mock is scripted to emit a malformed JSON agent_message")]
pub async fn script_codex_malformed_json_agent_message(world: &mut DaemonWorld) {
    let text = "definitely not valid json {";
    script_codex_agent_message_with_text(world, "codex-structured-bad", "thr-codex-bad", text)
        .await;
}

async fn script_codex_agent_message_with_text(
    world: &mut DaemonWorld,
    mock_name: &str,
    thread_id: &str,
    text: &str,
) {
    let agent_message = format!(
        r#"{{"type":"item.completed","item":{{"id":"m1","type":"agent_message","text":"{text}"}} }}"#
    );
    let thread_started = format!(r#"{{"type":"thread.started","thread_id":"{thread_id}"}}"#);
    let turn_completed = r#"{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0} }"#;
    let builder = world
        .mock_response(mock_name)
        .with_exit_code(0)
        .with_stdout_line(&thread_started)
        .with_stdout_line(r#"{"type":"turn.started"}"#)
        .with_stdout_line(&agent_message)
        .with_stdout_line(turn_completed);
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
