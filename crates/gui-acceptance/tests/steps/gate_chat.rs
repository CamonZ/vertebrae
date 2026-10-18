//! Gate chats: Resolve on a waiting human_input gate opens a local chat bound
//! to the gate. The harness launches are read back from the mock capture
//! directory, so assertions cover what each harness actually received.

use std::time::Duration;

use cucumber::{given, then};
use serde_json::Value;

use crate::GuiWorld;

const APPROVAL_SCHEMA: &str = r#"{"type":"object","required":["approved","reason"],"properties":{"approved":{"type":"boolean"},"reason":{"type":"string"}}}"#;

/// Heading that opens the hidden gate protocol in the developer instructions.
const GATE_PROTOCOL_HEADING: &str = "# Human input gate";

const LOCAL_CHAT_DEFAULTS_STORAGE_KEY: &str = "vertebrae.local-chat-provider-defaults.v2";

async fn add_human_input_step(world: &mut GuiWorld, args: &[&str], workflow_name: &str) {
    let workflow_id = world
        .workflow_id_by_name(workflow_name)
        .unwrap_or_else(|| panic!("no workflow ID found for '{workflow_name}' — create it first"))
        .clone();
    let mut command = vec![
        "step",
        "add",
        "--workflow",
        &workflow_id,
        "--harness",
        "claude",
        "--step-type",
        "human_input",
    ];
    command.extend_from_slice(args);
    world.run_vtb(&command).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step add failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    if let Some(id) = world.extract_step_id_from_output() {
        world.track_step(id);
    }
}

#[given(
    expr = "I create a human_input step {string} with instructions {string} and artifact {string} in the workflow {string} via the CLI"
)]
async fn create_resolvable_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    instructions: String,
    artifact: String,
    workflow_name: String,
) {
    add_human_input_step(
        world,
        &[
            &step_name,
            "--instructions",
            &instructions,
            "--artifact",
            &artifact,
            "--output-schema",
            APPROVAL_SCHEMA,
        ],
        &workflow_name,
    )
    .await;
}

#[given(
    expr = "I create a human_input step {string} without an artifact in the workflow {string} via the CLI"
)]
async fn create_unresolvable_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    workflow_name: String,
) {
    add_human_input_step(
        world,
        &[&step_name, "--output-schema", APPROVAL_SCHEMA],
        &workflow_name,
    )
    .await;
}

/// Store the default local chat provider the way Settings does. The next
/// navigation restarts the frontend, which reads it on startup.
#[given(expr = "the default local chat provider is {string} on the {string} harness")]
async fn default_local_chat_provider(world: &mut GuiWorld, provider: String, harness: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let stored = serde_json::json!({
        "defaultProvider": { "id": provider, "harness": harness },
        "providers": {},
    });
    client
        .execute(
            "window.localStorage.setItem(arguments[0], arguments[1]);",
            vec![
                LOCAL_CHAT_DEFAULTS_STORAGE_KEY.into(),
                stored.to_string().into(),
            ],
        )
        .await
        .expect("store default local chat provider");
}

/// Undo [`default_local_chat_provider`] so later scenarios start on the
/// built-in default. Runs after every scenario.
pub async fn reset_default_local_chat_provider(world: &GuiWorld) {
    let Some(wd) = world.webdriver.as_ref() else {
        return;
    };
    let client = wd.lock().await;
    let _ = client
        .execute(
            "window.localStorage.removeItem(arguments[0]);",
            vec![LOCAL_CHAT_DEFAULTS_STORAGE_KEY.into()],
        )
        .await;
}

#[then(expr = "the human_input gate should offer Resolve within {int} seconds")]
async fn gate_offers_resolve(world: &mut GuiWorld, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "enabled Resolve on a waiting human_input gate",
        r#"
          const gate = document.querySelector('[data-testid="human-input-gate"]');
          const resolve = gate?.querySelector('[data-testid="human-input-gate-resolve"]');
          return !!gate?.dataset.executionId && !!resolve && !resolve.disabled;
        "#,
        vec![],
        Duration::from_secs(timeout),
    )
    .await;
    world
        .screenshot(&client, "after-assert-gate-resolvable")
        .await;
}

#[then("the local chat should show no user messages")]
async fn local_chat_shows_no_user_messages(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let rows = client
        .execute(
            r#"
              return [...document.querySelectorAll(
                '[data-testid="chat-messages-scroll"] .evrow--user:not(.is-prompt):not(.is-system)'
              )].map((row) => row.textContent ?? '');
            "#,
            vec![],
        )
        .await
        .expect("read local chat user messages");
    world.screenshot(&client, "assert-no-user-messages").await;
    assert_eq!(
        rows.as_array().map(Vec::len),
        Some(0),
        "expected no user messages in the gate chat, found {rows}"
    );
}

#[then(expr = "the local chat composer should offer to resume its session within {int} seconds")]
async fn local_chat_composer_offers_resume(world: &mut GuiWorld, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "local chat composer offering to resume its session",
        r#"
          const composer = document.querySelector('[data-testid="local-chat-composer"]');
          return !!composer?.getAttribute('placeholder')?.includes('to resume');
        "#,
        vec![],
        Duration::from_secs(timeout),
    )
    .await;
    world
        .screenshot(&client, "after-assert-composer-offers-resume")
        .await;
}

/// The waiting gate's TaskRun and execution IDs, as the GUI renders them.
async fn waiting_gate_ids(world: &GuiWorld) -> (String, String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let ids = client
        .execute(
            r#"
              const gate = document.querySelector('[data-testid="human-input-gate"]');
              return gate ? [gate.dataset.runId ?? '', gate.dataset.executionId ?? ''] : null;
            "#,
            vec![],
        )
        .await
        .expect("read human_input gate IDs");
    let [run, execution] = ids
        .as_array()
        .map(|ids| [ids[0].as_str(), ids[1].as_str()])
        .unwrap_or_else(|| panic!("no human_input gate rendered: {ids}"));
    let (run, execution) = (run.unwrap_or_default(), execution.unwrap_or_default());
    assert!(
        !run.is_empty() && !execution.is_empty(),
        "gate IDs missing: {ids}"
    );
    (run.to_string(), execution.to_string())
}

fn capture_lines(file: &str) -> Vec<Value> {
    let path = std::path::Path::new(gui_acceptance::HARNESS_CAPTURE_DIR).join(file);
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Developer instructions of every gate chat session the harness started.
fn gate_session_instructions(harness: &str) -> Vec<String> {
    let instructions: Vec<String> = match harness {
        "claude" => capture_lines("invocations.jsonl")
            .iter()
            .filter_map(|argv| {
                let argv = argv.as_array()?;
                let flag = argv
                    .iter()
                    .position(|arg| arg == "--append-system-prompt")?;
                argv.get(flag + 1)?.as_str().map(ToOwned::to_owned)
            })
            .collect(),
        "codex" => capture_lines("codex_requests.jsonl")
            .iter()
            .filter(|request| request["method"] == "thread/start")
            .filter_map(|request| {
                request
                    .pointer("/params/developerInstructions")?
                    .as_str()
                    .map(ToOwned::to_owned)
            })
            .collect(),
        other => panic!("unknown harness {other:?}; use claude or codex"),
    };
    instructions
        .into_iter()
        .filter(|instructions| instructions.contains(GATE_PROTOCOL_HEADING))
        .collect()
}

#[then(
    expr = "the {string} harness should have started {int} gate chat(s) asking {string} with artifact {string}"
)]
async fn harness_started_gate_chats(
    world: &mut GuiWorld,
    harness: String,
    expected: usize,
    question: String,
    artifact: String,
) {
    let (task_run_id, execution_id) = waiting_gate_ids(world).await;
    let started = gui_acceptance::wait_until(
        "gate chat session start",
        Duration::from_secs(10),
        || async { Ok::<_, String>(gate_session_instructions(&harness).len() >= expected) },
    )
    .await;
    let sessions = gate_session_instructions(&harness);
    assert!(
        started.is_ok() && sessions.len() == expected,
        "expected {expected} {harness} gate chat session(s), found {}: {sessions:#?}",
        sessions.len()
    );
    let submit = format!(
        "vtb artifact add {artifact}.json --subject-type step_execution --subject-id {execution_id} --logical-name {artifact} --body '<JSON>'"
    );
    for instructions in &sessions {
        for expected in [
            format!("TaskRun {task_run_id} is paused at step"),
            question.clone(),
            r#""required": ["#.to_string(),
            submit.clone(),
            "[Vertebrae evaluation]".to_string(),
        ] {
            assert!(
                instructions.contains(&expected),
                "{harness} gate instructions lack {expected:?}:\n{instructions}"
            );
        }
    }
}

#[then("the Codex gate chat should open with a hidden turn")]
async fn codex_gate_chat_opens_with_hidden_turn(_world: &mut GuiWorld) {
    let opened = gui_acceptance::wait_until(
        "hidden Codex kickoff turn",
        Duration::from_secs(10),
        || async {
            Ok::<_, String>(
                capture_lines("codex_requests.jsonl")
                    .iter()
                    .filter(|request| request["method"] == "turn/start")
                    .filter_map(|request| request.pointer("/params/input/0/text")?.as_str())
                    .any(|text| text.starts_with("<vertebrae-hidden-turn>")),
            )
        },
    )
    .await;
    assert!(
        opened.is_ok(),
        "no hidden kickoff turn reached Codex: {:#?}",
        capture_lines("codex_requests.jsonl")
    );
}
