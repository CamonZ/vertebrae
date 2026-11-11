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

#[when("I open the created task's run in the chat")]
pub async fn open_task_run_in_chat(world: &mut GuiWorld) {
    // Navigating to /tasks directly skips the pipeline → tasks tab → click
    // chain. The navigation reloads the frontend.
    crate::steps::navigation::navigate_to(world, "/tasks", "nav-run-chat-task").await;
    follow_run_chat_link(world).await;
}

#[when("I reopen the created task's run in the chat without reloading")]
pub async fn reopen_task_run_in_chat(world: &mut GuiWorld) {
    {
        let wd = world
            .webdriver
            .as_ref()
            .expect("WebDriver session not initialized")
            .clone();
        let client = wd.lock().await;
        // A closing panel keeps its run pane mounted while it animates out.
        gui_acceptance::wait_for_js(
            &client,
            "no run pane",
            r#"return !document.querySelector('[data-testid="run-pane"]');"#,
            vec![],
            Duration::from_secs(5),
        )
        .await;
    }
    follow_run_chat_link(world).await;
}

/// Follow the `#task=<id>` deep link on the current page: it opens the task's
/// active or newest run in the maximized chat from any page.
async fn follow_run_chat_link(world: &mut GuiWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    // The run may not exist yet when the step starts; the app clears the hash
    // after handling it, so re-arm it until a run pane renders.
    gui_acceptance::wait_for_js(
        &client,
        "run pane for the created task",
        r#"const [hash] = arguments;
        if (document.querySelector('[data-testid="run-pane"]')) return true;
        if (!location.hash) location.hash = hash;
        return false;"#,
        vec![format!("task={task_id}").into()],
        Duration::from_secs(30),
    )
    .await;
    world.screenshot(&client, "run-chat-task").await;
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
            let daemon_log = world
                .daemon_log_path
                .as_ref()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .unwrap_or_else(|| "<daemon log unavailable>".to_string());
            let tail = daemon_log
                .lines()
                .rev()
                .take(80)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            panic!(
                "no completed execution for task {task_id} within {timeout_secs}s: {resp}\ndaemon log:\n{tail}"
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
