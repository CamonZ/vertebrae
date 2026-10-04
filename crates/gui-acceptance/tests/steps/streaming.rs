//! Streaming assistant text through the daemon, Sacrum and the GUI.
//!
//! Each provider mock streams one assistant item as text deltas, pauses
//! mid-item so the scenario can observe partial text, then finishes the item
//! with its completed snapshot and reports usage. Sacrum broadcasts the deltas
//! without storing them and persists only the snapshot.

use cucumber::{given, then, when};
use fantoccini::Locator;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use crate::GuiWorld;

/// Pause before the first delta, long enough to open the traces page so the
/// GUI is subscribed before anything streams.
const PAUSE_BEFORE_FIRST_DELTA_MS: u64 = 10_000;
/// Pause after the first delta, while the scenario checks the partial text.
const PAUSE_AFTER_FIRST_DELTA_MS: u64 = 12_000;

const ITEM_ID: &str = "msg-gui-stream";

struct Usage {
    input: u64,
    cached: u64,
    output: u64,
}

#[given(expr = "the step runs on the {string} harness")]
pub async fn step_runs_on_harness(world: &mut GuiWorld, harness: String) {
    match harness.as_str() {
        // Steps created through the CLI already default to Claude.
        "claude" => {}
        "codex" => {
            let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
            world
                .run_vtb(&[
                    "step",
                    "update",
                    &step_id,
                    "--provider",
                    "openai",
                    "--harness",
                    "codex",
                    "--model",
                    "gpt-5.5",
                ])
                .await;
            assert_eq!(
                world.last_exit_code, 0,
                "vtb step update --harness codex failed:\nstdout: {}\nstderr: {}",
                world.last_stdout, world.last_stderr
            );
        }
        other => panic!("unknown harness {other:?}"),
    }
}

#[given(
    expr = "the {string} mock streams {string}, {string} and {string} reporting {int} input, {int} cached and {int} output tokens"
)]
#[allow(clippy::too_many_arguments)]
pub async fn set_streaming_prompt(
    world: &mut GuiWorld,
    harness: String,
    first: String,
    second: String,
    third: String,
    input: u64,
    cached: u64,
    output: u64,
) {
    // Fragments are separated by spaces, so the completed text reads as words.
    let fragments = [format!("{first} "), format!("{second} "), third];
    let usage = Usage {
        input,
        cached,
        output,
    };
    let builder = world.mock_response("stream");
    let builder = match harness.as_str() {
        "claude" => claude_stream(builder, &fragments, &usage),
        "codex" => codex_stream(builder, &fragments, &usage),
        other => panic!("unknown harness {other:?}"),
    };
    let envelope = builder.build().expect("MockResponse envelope builds");
    let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--prompt", &envelope])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step update --prompt failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );
}

/// Claude `stream-json` output with partial messages: the deltas of one text
/// block, the completed assistant snapshot of that block, and the terminal
/// result. Only the result's usage is a turn total; the assistant and
/// `message_delta` usage are context snapshots and must not add to it.
fn claude_stream(
    builder: daemon_acceptance::MockResponse,
    fragments: &[String; 3],
    usage: &Usage,
) -> daemon_acceptance::MockResponse {
    let session = "sess-gui-stream";
    let usage = json!({
        "input_tokens": usage.input,
        "cache_read_input_tokens": usage.cached,
        "output_tokens": usage.output
    });
    let stream_event =
        |event: Value| line(json!({"type": "stream_event", "session_id": session, "event": event}));
    let text_delta = |text: &str| {
        stream_event(json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": text}
        }))
    };
    let text = fragments.concat();

    builder
        .with_stdout_line(line(
            json!({"type": "system", "subtype": "init", "session_id": session}),
        ))
        .with_stdout_pause(PAUSE_BEFORE_FIRST_DELTA_MS)
        .with_stdout_line(stream_event(
            json!({"type": "message_start", "message": {"id": ITEM_ID}}),
        ))
        .with_stdout_line(stream_event(json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""}
        })))
        .with_stdout_line(text_delta(&fragments[0]))
        .with_stdout_pause(PAUSE_AFTER_FIRST_DELTA_MS)
        .with_stdout_line(text_delta(&fragments[1]))
        .with_stdout_line(text_delta(&fragments[2]))
        .with_stdout_line(line(json!({
            "type": "assistant",
            "session_id": session,
            "message": {
                "id": ITEM_ID,
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
                "usage": usage
            }
        })))
        .with_stdout_line(stream_event(
            json!({"type": "content_block_stop", "index": 0}),
        ))
        .with_stdout_line(stream_event(json!({
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": usage
        })))
        .with_stdout_line(stream_event(json!({"type": "message_stop"})))
        .with_stdout_line(line(json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "duration_ms": 1.0,
            "result": "done",
            "session_id": session,
            "usage": usage
        })))
}

/// Codex App Server notifications for one agent message: its deltas, the
/// completed item, and one token usage update for the turn.
fn codex_stream(
    builder: daemon_acceptance::MockResponse,
    fragments: &[String; 3],
    usage: &Usage,
) -> daemon_acceptance::MockResponse {
    let notification =
        |method: &str, params: Value| line(json!({"method": method, "params": params}));
    let text_delta = |text: &str| {
        notification(
            "item/agentMessage/delta",
            json!({"itemId": ITEM_ID, "delta": text}),
        )
    };
    let tokens = json!({
        "totalTokens": usage.input + usage.output,
        "inputTokens": usage.input,
        "cachedInputTokens": usage.cached,
        "outputTokens": usage.output,
        "reasoningTokens": 0
    });

    builder
        .with_stdout_pause(PAUSE_BEFORE_FIRST_DELTA_MS)
        .with_stdout_line(notification(
            "item/started",
            json!({"item": {"id": ITEM_ID, "type": "agentMessage", "text": ""}}),
        ))
        .with_stdout_line(text_delta(&fragments[0]))
        .with_stdout_pause(PAUSE_AFTER_FIRST_DELTA_MS)
        .with_stdout_line(text_delta(&fragments[1]))
        .with_stdout_line(text_delta(&fragments[2]))
        .with_stdout_line(notification(
            "item/completed",
            json!({"item": {"id": ITEM_ID, "type": "agentMessage", "text": fragments.concat()}}),
        ))
        .with_stdout_line(notification(
            "thread/tokenUsage/updated",
            json!({
                "tokenUsage": {
                    "total": tokens,
                    "last": tokens,
                    "modelContextWindow": 258_400
                }
            }),
        ))
        .with_stdout_line(notification(
            "turn/completed",
            json!({"turn": {"status": "completed", "durationMs": 1}}),
        ))
}

/// Serialize a fixture line. Sacrum treats `}}` as a Liquid trigger while the
/// envelope travels through the step prompt, so adjacent closing braces are
/// separated by whitespace, which leaves the JSON unchanged.
fn line(value: Value) -> String {
    let mut encoded = value.to_string();
    while encoded.contains("}}") {
        encoded = encoded.replace("}}", "} }");
    }
    encoded
}

#[then(expr = "the only assistant message should read {string} within {int} seconds")]
pub async fn only_assistant_message_reads(world: &mut GuiWorld, expected: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut texts = Vec::new();

    while Instant::now() < deadline {
        texts.clear();
        // The unified chat renders agent text in `.evprose` within agent rows.
        let elements = client
            .find_all(Locator::Css(".evrow--agent .evprose"))
            .await
            .unwrap_or_default();
        for element in elements {
            // An element can detach while the stream re-renders the message.
            if let Ok(Some(text)) = element.prop("textContent").await {
                texts.push(text.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        }
        if texts == [expected.as_str()] {
            world
                .screenshot(&client, &format!("assistant-message-{expected}"))
                .await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    world
        .screenshot(&client, &format!("fail-assistant-message-{expected}"))
        .await;
    panic!(
        "expected exactly one assistant message reading {expected:?} within {timeout} seconds, found {texts:?}"
    );
}

/// After the step completes, the thread folds an agent message whose text
/// equals the execution output into the output card, so the text may render
/// in either place. Either way it must appear exactly once.
#[then(expr = "the conversation should show {string} exactly once within {int} seconds")]
pub async fn conversation_shows_once(world: &mut GuiWorld, expected: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut occurrences = 0;

    while Instant::now() < deadline {
        let text = match client
            .find(Locator::Css("[data-testid=\"unified-chat-view\"]"))
            .await
        {
            Ok(view) => view.prop("textContent").await.ok().flatten(),
            Err(_) => None,
        };
        occurrences = text
            .map(|text| {
                text.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .matches(expected.as_str())
                    .count()
            })
            .unwrap_or(0);
        if occurrences == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    world
        .screenshot(&client, &format!("fail-conversation-once-{expected}"))
        .await;
    panic!(
        "expected the conversation to show {expected:?} exactly once within {timeout} seconds, found it {occurrences} times"
    );
}

#[then(expr = "the element with test id {string} should read {string} within {int} seconds")]
pub async fn element_reads(world: &mut GuiWorld, test_id: String, expected: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut actual = None;

    while Instant::now() < deadline {
        actual = match client
            .find(Locator::Css(&format!("[data-testid=\"{test_id}\"]")))
            .await
        {
            Ok(element) => element
                .text()
                .await
                .ok()
                .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ")),
            Err(_) => None,
        };
        if actual.as_deref() == Some(expected.as_str()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    world
        .screenshot(&client, &format!("fail-testid-text-{test_id}"))
        .await;
    panic!("expected {test_id:?} to read {expected:?} within {timeout} seconds, found {actual:?}");
}

#[then(expr = "Sacrum stores the assistant text {string} once and no text deltas")]
pub async fn sacrum_stores_snapshot_only(world: &mut GuiWorld, expected: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not initialized")
        .clone();
    let executions_query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    let executions: Value = client
        .execute(
            &executions_query,
            json!({"task_id": task_id}),
            "step_executions",
        )
        .await
        .expect("step_executions query failed");
    let executions = executions.as_array().expect("step_executions is a list");
    assert_eq!(
        executions.len(),
        1,
        "expected one execution for the task: {executions:?}"
    );
    let execution_id = executions[0]["id"].as_str().expect("execution id");

    let logs: Value = client
        .execute(
            vertebrae_sacrum_client::queries::executions::LIST_LOGS,
            json!({"step_execution_id": execution_id}),
            "session_logs",
        )
        .await
        .expect("session_logs query failed");
    let text_events: Vec<Value> = logs
        .as_array()
        .expect("session_logs is a list")
        .iter()
        .filter_map(|log| log["content"].as_str())
        .filter_map(|content| serde_json::from_str::<Value>(content).ok())
        .filter(|event| event["type"] == "text")
        .collect();

    let deltas: Vec<&Value> = text_events
        .iter()
        .filter(|event| event["semantics"] == "delta")
        .collect();
    assert!(deltas.is_empty(), "text deltas were stored: {deltas:?}");

    let snapshots: Vec<&str> = text_events
        .iter()
        .filter(|event| event["semantics"] == "snapshot")
        .filter_map(|event| event["data"]["text"].as_str())
        .collect();
    assert_eq!(
        snapshots,
        [expected.as_str()],
        "expected one stored text snapshot"
    );
}

#[when("I reload the traces page for the created task")]
pub async fn reload_traces_page(world: &mut GuiWorld) {
    // A full navigation restarts the frontend, so the page renders only what
    // Sacrum returns from storage.
    crate::steps::daemon::navigate_to_traces_for_task(world).await;
}
