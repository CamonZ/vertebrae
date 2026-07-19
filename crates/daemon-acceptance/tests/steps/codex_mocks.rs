use cucumber::when;

use crate::DaemonWorld;

fn notification(method: &str, params: serde_json::Value) -> String {
    let mut encoded = serde_json::json!({"method": method, "params": params}).to_string();
    // Sacrum treats `}}` as a Liquid-template trigger while the fixture
    // envelope is transported through the prompt field. Whitespace between
    // adjacent closing JSON objects preserves the wire payload and keeps it
    // inert during that template pass.
    while encoded.contains("}}") {
        encoded = encoded.replace("}}", "} }");
    }
    encoded
}

fn completed_turn(input_tokens: i64, output_tokens: i64) -> String {
    notification(
        "turn/completed",
        serde_json::json!({
            "turn": {"status": "completed", "durationMs": 1234},
            "tokenUsage": {
                "total": {
                    "inputTokens": input_tokens,
                    "cachedInputTokens": 200,
                    "outputTokens": output_tokens,
                    "reasoningTokens": 0
                }
            }
        }),
    )
}

fn failed_turn(message: &str) -> String {
    notification(
        "turn/completed",
        serde_json::json!({
            "turn": {"status": "failed", "error": {"message": message}}
        }),
    )
}

#[when("the codex mock is scripted to succeed with full metrics")]
pub async fn script_codex_success_with_metrics(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("codex-happy")
        .with_stdout_line(notification(
            "item/completed",
            serde_json::json!({
                "item": {"id": "m1", "type": "agentMessage", "text": "codex-final-answer"}
            }),
        ))
        .with_stdout_line(completed_turn(1500, 800));
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to succeed without an agent_message")]
pub async fn script_codex_success_without_agent_message(world: &mut DaemonWorld) {
    // The App Server still completes the turn, but sends no item containing
    // agent text or token usage.
    let builder = world.mock_response("codex-no-message");
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit three jsonl item events")]
pub async fn script_codex_three_item_events(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("codex-three-events")
        .with_stdout_line(notification(
            "item/started",
            serde_json::json!({
                "item": {"id": "c1", "type": "commandExecution", "command": "ls"}
            }),
        ))
        .with_stdout_line(notification(
            "item/completed",
            serde_json::json!({
                "item": {
                    "id": "c1",
                    "type": "commandExecution",
                    "output": "listed",
                    "status": "completed"
                }
            }),
        ))
        .with_stdout_line(notification(
            "item/completed",
            serde_json::json!({
                "item": {"id": "m1", "type": "agentMessage", "text": "three-events-done"}
            }),
        ));
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit an error event")]
pub async fn script_codex_emits_error_event(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("codex-error-event")
        .with_exit_code(1)
        .with_stdout_line(notification(
            "error",
            serde_json::json!({"message": "codex-mock-thread-failure"}),
        ))
        .with_stderr_line("codex: thread failed");
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit a turn.failed event")]
pub async fn script_codex_emits_turn_failed(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("codex-turn-failed")
        .with_exit_code(1)
        .with_stdout_line(failed_turn("codex-mock-turn-failure"));
    set_prompt(world, builder).await;
}

#[when("the codex mock is scripted to emit a structured JSON agent_message")]
pub async fn script_codex_structured_json_agent_message(world: &mut DaemonWorld) {
    script_codex_agent_message_with_text(
        world,
        "codex-structured-ok",
        r#"{"verdict":"approved","score":0.92}"#,
    )
    .await;
}

#[when("the codex mock is scripted to emit a malformed JSON agent_message")]
pub async fn script_codex_malformed_json_agent_message(world: &mut DaemonWorld) {
    script_codex_agent_message_with_text(
        world,
        "codex-structured-bad",
        "definitely not valid json {",
    )
    .await;
}

async fn script_codex_agent_message_with_text(
    world: &mut DaemonWorld,
    mock_name: &str,
    text: &str,
) {
    let builder = world
        .mock_response(mock_name)
        .with_stdout_line(notification(
            "item/completed",
            serde_json::json!({
                "item": {"id": "m1", "type": "agentMessage", "text": text}
            }),
        ))
        .with_stdout_line(completed_turn(120, 40));
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
