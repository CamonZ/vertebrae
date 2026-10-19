//! Gate chats: Resolve on a waiting human_input gate opens a local chat bound
//! to the gate. The harness launches are read back from the mock capture
//! directory, so assertions cover what each harness actually received.

use std::time::Duration;

use cucumber::{given, then, when};
use serde_json::Value;

use crate::GuiWorld;

/// Not draftable: the nested `details` object keeps the gate on the
/// whole-artifact protocol.
const APPROVAL_SCHEMA: &str = r#"{"type":"object","required":["approved","reason"],"properties":{"approved":{"type":"boolean"},"reason":{"type":"string"},"details":{"type":"object"}}}"#;

/// Draftable: every property is a boolean or a string, so Sacrum accepts the
/// response field by field.
const DRAFTABLE_APPROVAL_SCHEMA: &str = r#"{"type":"object","required":["approved","reason"],"properties":{"approved":{"type":"boolean","description":"Should it ship?"},"reason":{"type":"string","description":"Why?"}}}"#;

const UI_STORAGE_KEY: &str = "vertebrae-ui-storage";

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
    expr = "I create a human_input step {string} with question {string} and artifact {string} in the workflow {string} via the CLI"
)]
async fn create_resolvable_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    question: String,
    artifact: String,
    workflow_name: String,
) {
    add_human_input_step(
        world,
        &[
            &step_name,
            "--question",
            &question,
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
    expr = "I create a draftable human_input step {string} with question {string} and artifact {string} in the workflow {string} via the CLI"
)]
async fn create_draftable_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    question: String,
    artifact: String,
    workflow_name: String,
) {
    add_human_input_step(
        world,
        &[
            &step_name,
            "--question",
            &question,
            "--artifact",
            &artifact,
            "--output-schema",
            DRAFTABLE_APPROVAL_SCHEMA,
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

/// Run `vtb step add` in `workflow_id` and return the new step's ID.
async fn add_step(world: &mut GuiWorld, workflow_id: &str, args: &[&str]) -> String {
    let mut command = vec!["step", "add", "--workflow", workflow_id];
    command.extend_from_slice(args);
    world.run_vtb(&command).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step add failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let id = world
        .extract_step_id_from_output()
        .unwrap_or_else(|| panic!("no step ID in: {}", world.last_stdout));
    world.track_step(id.clone());
    id
}

async fn update_step(world: &mut GuiWorld, step_id: &str, args: &[&str]) {
    let mut command = vec!["step", "update", step_id];
    command.extend_from_slice(args);
    world.run_vtb(&command).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step update failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

/// A gate followed by its review: the `decide` route sends an answer with
/// `approved: false` back to the gate, carrying its `reason` as the handoff,
/// and anything else to a `done` finish step.
#[given(
    expr = "I create a reviewed human_input step {string} with question {string} and artifact {string} in the workflow {string} via the CLI"
)]
async fn create_reviewed_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    question: String,
    artifact: String,
    workflow_name: String,
) {
    add_reviewed_gate(
        world,
        &step_name,
        &question,
        &artifact,
        &workflow_name,
        APPROVAL_SCHEMA,
    )
    .await;
}

#[given(
    expr = "I create a reviewed draftable human_input step {string} with question {string} and artifact {string} in the workflow {string} via the CLI"
)]
async fn create_reviewed_draftable_human_input_step(
    world: &mut GuiWorld,
    step_name: String,
    question: String,
    artifact: String,
    workflow_name: String,
) {
    add_reviewed_gate(
        world,
        &step_name,
        &question,
        &artifact,
        &workflow_name,
        DRAFTABLE_APPROVAL_SCHEMA,
    )
    .await;
}

async fn add_reviewed_gate(
    world: &mut GuiWorld,
    step_name: &str,
    question: &str,
    artifact: &str,
    workflow_name: &str,
    schema: &str,
) {
    let workflow_id = world
        .workflow_id_by_name(workflow_name)
        .unwrap_or_else(|| panic!("no workflow ID found for '{workflow_name}' — create it first"))
        .clone();
    let done = add_step(
        world,
        &workflow_id,
        &["--harness", "claude", "--step-type", "finish", "done"],
    )
    .await;
    let gate = add_step(
        world,
        &workflow_id,
        &[
            "--harness",
            "claude",
            "--step-type",
            "human_input",
            step_name,
            "--question",
            question,
            "--artifact",
            artifact,
            "--output-schema",
            schema,
        ],
    )
    .await;
    let decide = add_step(
        world,
        &workflow_id,
        &[
            "--harness",
            "claude",
            "--step-type",
            "route",
            "decide",
            "--transition-to",
            &gate,
            "--transition-to",
            &done,
        ],
    )
    .await;
    // The route validates its references against its predecessors' schemas.
    update_step(world, &gate, &["--transition-to", &decide]).await;
    let route_config = serde_json::json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [{
            "id": "rejected",
            "when": { "ref": "previous_output.approved", "op": "eq", "value": false },
            "transition": { "type": "intra_workflow", "step_id": gate },
            "handoff": { "reasons": "{{ previous_output.reason }}" }
        }],
        "default": {
            "transition": { "type": "intra_workflow", "step_id": done },
            "handoff": {}
        }
    });
    update_step(
        world,
        &decide,
        &["--route-config", &route_config.to_string()],
    )
    .await;
}

/// Attach a resolution to the waiting gate the way the gate chat's agent
/// does, with the exact command its protocol prescribes.
#[when(expr = "I resolve the waiting gate's {string} artifact with {string} via the CLI")]
async fn resolve_waiting_gate(world: &mut GuiWorld, artifact: String, body: String) {
    let (_, execution_id) = waiting_gate_ids(world).await;
    let filename = format!("{artifact}.json");
    world
        .run_vtb(&[
            "artifact",
            "add",
            &filename,
            "--subject-type",
            "step_execution",
            "--subject-id",
            &execution_id,
            "--logical-name",
            &artifact,
            "--body",
            &body,
        ])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb artifact add failed: {}{}",
        world.last_stdout, world.last_stderr
    );
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

/// The live chat is idle: its last turn settled and nothing is queued.
#[then(expr = "the local chat should be ready for a message within {int} seconds")]
async fn local_chat_ready_for_message(world: &mut GuiWorld, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "idle local chat composer",
        r#"
          const composer = document.querySelector('[data-testid="local-chat-composer"]');
          return composer?.getAttribute('placeholder') === 'Type a message...';
        "#,
        vec![],
        Duration::from_secs(timeout),
    )
    .await;
    world.screenshot(&client, "after-assert-chat-ready").await;
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
        assert!(
            !instructions.contains("vtb gate "),
            "a whole-artifact gate offers draft commands:\n{instructions}"
        );
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

/// Hidden Claude turns that carry the review's verdict.
fn claude_evaluation_turns() -> Vec<String> {
    capture_lines("stdin_turns.jsonl")
        .iter()
        .filter_map(Value::as_str)
        .filter(|text| text.starts_with("<vertebrae-hidden-turn>\n[Vertebrae evaluation]"))
        .map(ToOwned::to_owned)
        .collect()
}

#[then(
    expr = "the gate chat should receive {int} evaluation turn(s) for attempt {int} with reasons {string}"
)]
async fn gate_chat_receives_evaluation(
    world: &mut GuiWorld,
    expected: usize,
    attempt: u32,
    reasons: String,
) {
    let (_, execution_id) = waiting_gate_ids(world).await;
    let delivered = gui_acceptance::wait_until(
        "gate chat evaluation turn",
        Duration::from_secs(15),
        || async { Ok::<_, String>(claude_evaluation_turns().len() >= expected) },
    )
    .await;
    // Realtime updates keep arriving after re-entry; give duplicates time to
    // land before counting.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let turns = claude_evaluation_turns();
    assert!(
        delivered.is_ok() && turns.len() == expected,
        "expected {expected} evaluation turn(s), found {}: {turns:#?}",
        turns.len()
    );
    for turn in &turns {
        for expected in [
            format!("attempt {attempt}"),
            reasons.clone(),
            execution_id.clone(),
        ] {
            assert!(
                turn.contains(&expected),
                "evaluation turn lacks {expected:?}:\n{turn}"
            );
        }
    }
}

/// Gate chat instructions that ask `question` on the draft protocol.
fn draft_gate_sessions(harness: &str, question: &str) -> Vec<String> {
    gate_session_instructions(harness)
        .into_iter()
        .filter(|instructions| {
            instructions.contains(question) && instructions.contains("## Recording answers")
        })
        .collect()
}

#[then(expr = "the {string} harness should have started {int} draft gate chat(s) asking {string}")]
async fn harness_started_draft_gate_chats(
    world: &mut GuiWorld,
    harness: String,
    expected: usize,
    question: String,
) {
    if expected == 0 {
        // Nothing waits once the gate resolved without a chat.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let sessions = draft_gate_sessions(&harness, &question);
        assert!(
            sessions.is_empty(),
            "unexpected draft gate chats: {sessions:#?}"
        );
        return;
    }
    let (_, execution_id) = waiting_gate_ids(world).await;
    let started = gui_acceptance::wait_until(
        "draft gate chat session start",
        Duration::from_secs(10),
        || async { Ok::<_, String>(draft_gate_sessions(&harness, &question).len() >= expected) },
    )
    .await;
    let sessions = draft_gate_sessions(&harness, &question);
    assert!(
        started.is_ok() && sessions.len() == expected,
        "expected {expected} {harness} draft gate chat(s), found {}: {sessions:#?}",
        sessions.len()
    );
    for instructions in &sessions {
        for expected in [
            format!("vtb gate set {execution_id} --values '<JSON object>'"),
            format!("vtb gate show {execution_id}"),
            format!("vtb --json gate submit {execution_id}"),
            "[Vertebrae steering]".to_string(),
            "- approved (required, boolean): Should it ship?".to_string(),
        ] {
            assert!(
                instructions.contains(&expected),
                "{harness} draft gate instructions lack {expected:?}:\n{instructions}"
            );
        }
        assert!(
            !instructions.contains(&format!("--subject-id {execution_id}")),
            "a draftable gate offers the whole-artifact command:\n{instructions}"
        );
    }
}

#[then(
    expr = "the latest {string} gate chat asking {string} should start from the answer {string} with {string} still needed"
)]
async fn latest_gate_chat_starts_from_draft(
    _world: &mut GuiWorld,
    harness: String,
    question: String,
    answer: String,
    missing: String,
) {
    let sessions = draft_gate_sessions(&harness, &question);
    let latest = sessions
        .last()
        .unwrap_or_else(|| panic!("no {harness} draft gate chat asking {question:?}"));
    for expected in [
        "## Answers so far".to_string(),
        format!("- {answer}"),
        format!("Still needed: {missing}"),
    ] {
        assert!(
            latest.contains(&expected),
            "the latest gate chat does not start from the draft ({expected:?}):\n{latest}"
        );
    }
}

/// Hidden Claude turns that begin with `marker`, such as `[Vertebrae steering]`.
fn claude_hidden_turns(marker: &str) -> Vec<String> {
    let prefix = format!("<vertebrae-hidden-turn>\n{marker}");
    capture_lines("stdin_turns.jsonl")
        .iter()
        .filter_map(Value::as_str)
        .filter(|text| text.starts_with(&prefix))
        .map(ToOwned::to_owned)
        .collect()
}

/// `expected` hints so far, the latest naming exactly what is still needed.
#[then(expr = "the gate chat should receive {int} steering turn(s) naming {string}")]
async fn gate_chat_receives_steering(_world: &mut GuiWorld, expected: usize, needed: String) {
    let delivered = gui_acceptance::wait_until(
        "gate chat steering turn",
        Duration::from_secs(15),
        || async { Ok::<_, String>(claude_hidden_turns("[Vertebrae steering]").len() >= expected) },
    )
    .await;
    // Later renders must not repeat the hint for the same stall.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let turns = claude_hidden_turns("[Vertebrae steering]");
    assert!(
        delivered.is_ok() && turns.len() == expected,
        "expected {expected} steering turn(s), found {}: {turns:#?}",
        turns.len()
    );
    let latest = turns.last().expect("at least one steering turn");
    assert!(
        latest.contains(&format!("Still needed: {needed}")),
        "the latest steering turn does not name {needed:?}:\n{latest}"
    );
}

#[then(expr = "the gate chat should receive a form turn reporting {string}")]
async fn gate_chat_receives_form_turn(_world: &mut GuiWorld, answer: String) {
    let delivered =
        gui_acceptance::wait_until("gate chat form turn", Duration::from_secs(15), || async {
            Ok::<_, String>(
                claude_hidden_turns("[Vertebrae form]")
                    .iter()
                    .any(|turn| turn.contains(&answer)),
            )
        })
        .await;
    assert!(
        delivered.is_ok(),
        "no form turn reported {answer:?}: {:#?}",
        claude_hidden_turns("[Vertebrae form]")
    );
}

#[then("the gate chat should open with the recovery turn")]
async fn gate_chat_opens_with_recovery_turn(_world: &mut GuiWorld) {
    let opened = gui_acceptance::wait_until(
        "gate chat recovery turn",
        Duration::from_secs(10),
        || async {
            Ok::<_, String>(
                capture_lines("stdin_turns.jsonl")
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|text| text.contains("after the earlier chat ended")),
            )
        },
    )
    .await;
    assert!(
        opened.is_ok(),
        "no recovery turn reached Claude: {:#?}",
        capture_lines("stdin_turns.jsonl")
    );
}

#[then(expr = "the evaluation turn should present {string} as a previous answer")]
async fn evaluation_turn_presents_previous_answer(_world: &mut GuiWorld, answer: String) {
    let turns = claude_hidden_turns("[Vertebrae evaluation]");
    let latest = turns
        .last()
        .expect("no evaluation turn reached the gate chat");
    for expected in [
        "from the previous attempt".to_string(),
        format!("- {answer}"),
    ] {
        assert!(
            latest.contains(&expected),
            "the evaluation turn lacks {expected:?}:\n{latest}"
        );
    }
}

/// Record answers in the waiting gate's draft with the command a draftable
/// gate chat's agent runs.
#[when(expr = "I set the waiting gate's draft to {string} via the CLI")]
async fn set_waiting_gate_draft(world: &mut GuiWorld, values: String) {
    let (_, execution_id) = waiting_gate_ids(world).await;
    world
        .run_vtb(&["gate", "set", &execution_id, "--values", &values])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb gate set failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I submit the waiting gate's draft via the CLI")]
async fn submit_waiting_gate_draft(world: &mut GuiWorld) {
    let (_, execution_id) = waiting_gate_ids(world).await;
    world.run_vtb(&["gate", "submit", &execution_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb gate submit failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[then(expr = "the gate draft progress should show {string} as {string} within {int} seconds")]
async fn gate_draft_progress_shows(
    world: &mut GuiWorld,
    field: String,
    state: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        &format!("gate draft field {field} {state}"),
        r#"
          const row = [...document.querySelectorAll('[data-testid="gate-draft-field"]')]
            .find((row) => row.dataset.field === arguments[0]);
          return row?.dataset.state === arguments[1];
        "#,
        vec![field.clone().into(), state.clone().into()],
        Duration::from_secs(timeout),
    )
    .await;
    world
        .screenshot(&client, &format!("after-assert-draft-{field}-{state}"))
        .await;
}

/// Steer gate chats after fewer stalled turns. Stored the way Settings does;
/// the next navigation restarts the frontend, which reads it on startup.
#[given(expr = "gate chats are steered after {int}, {int} and {int} stalled turns")]
async fn gate_steering_thresholds(world: &mut GuiWorld, soft: u32, form: u32, escape: u32) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    client
        .execute(
            r#"
              const stored = JSON.parse(window.localStorage.getItem(arguments[0]) ?? 'null')
                ?? { state: {}, version: 0 };
              stored.state = {
                ...stored.state,
                gateSteeringThresholds: { soft: arguments[1], form: arguments[2], escape: arguments[3] },
              };
              window.localStorage.setItem(arguments[0], JSON.stringify(stored));
            "#,
            vec![
                UI_STORAGE_KEY.into(),
                soft.into(),
                form.into(),
                escape.into(),
            ],
        )
        .await
        .expect("store gate steering thresholds");
}

/// Undo [`gate_steering_thresholds`]. Runs after every scenario.
pub async fn reset_gate_steering_thresholds(world: &GuiWorld) {
    let Some(wd) = world.webdriver.as_ref() else {
        return;
    };
    let client = wd.lock().await;
    let _ = client
        .execute(
            r#"
              const stored = JSON.parse(window.localStorage.getItem(arguments[0]) ?? 'null');
              if (stored?.state?.gateSteeringThresholds) {
                delete stored.state.gateSteeringThresholds;
                window.localStorage.setItem(arguments[0], JSON.stringify(stored));
              }
            "#,
            vec![UI_STORAGE_KEY.into()],
        )
        .await;
}

#[then(expr = "the vtb output should contain {string}")]
async fn vtb_output_contains(world: &mut GuiWorld, expected: String) {
    assert!(
        world.last_stdout.contains(&expected),
        "vtb output lacks {expected:?}:\n{}{}",
        world.last_stdout,
        world.last_stderr
    );
}

/// Hidden steering and form turns never render as the user's messages.
#[then(expr = "the local chat should show {int} user messages, none of them from Vertebrae")]
async fn local_chat_user_messages_exclude_hidden_turns(world: &mut GuiWorld, expected: usize) {
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
    world.screenshot(&client, "assert-user-messages").await;
    let rows: Vec<String> = rows
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(rows.len(), expected, "unexpected user messages: {rows:#?}");
    assert!(
        rows.iter()
            .all(|row| !row.contains("[Vertebrae") && !row.contains("vertebrae-hidden-turn")),
        "a hidden Vertebrae turn rendered as a user message: {rows:#?}"
    );
}
