//! Named llm_inference sessions: steps authored with `vtb step add
//! --session-name/--session-mode` start or resume one provider conversation
//! within a TaskRun.

use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::DaemonWorld;

const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
const SESSION_NAME: &str = "conv";

/// Steps of the session workflow, in run order.
const STEP_NAMES: [&str; 2] = ["first", "second"];

const SESSION_EXECUTIONS: &str = r#"
    query SessionExecutions($task_id: Uuid4!) {
        step_executions(task_id: $task_id) {
            id step_name status output session_name native_session_id inserted_at
        }
    }
"#;

#[given(expr = "a {string} workflow whose session steps use modes {string}")]
pub async fn given_session_workflow(world: &mut DaemonWorld, harness: String, modes: String) {
    let modes: Vec<&str> = modes.split(", ").collect();
    assert!(
        (1..=STEP_NAMES.len()).contains(&modes.len()),
        "expected one or two comma-separated modes, got {modes:?}"
    );

    let wf_name = format!("daemon-acc-session-{}", uuid::Uuid::new_v4().simple());
    world.run_vtb(&["workflow", "add", &wf_name]).await;
    world.assert_vtb_ok("workflow add");
    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.workflow_id = Some(workflow_id.clone());
    world.created_workflow_ids.push(workflow_id.clone());

    let provider_args: &[&str] = match harness.as_str() {
        "claude" => &["--model", "claude-sonnet-4-6"],
        "codex" => &[
            "--provider",
            "openai",
            "--model",
            "gpt-5.5",
            "--reasoning-effort",
            "high",
        ],
        other => panic!("unsupported session harness {other:?}"),
    };
    for (order, (name, mode)) in STEP_NAMES.iter().zip(&modes).enumerate() {
        let order = order.to_string();
        let mut args = vec![
            "step",
            "add",
            name,
            "--workflow",
            &workflow_id,
            "--harness",
            &harness,
            "--order",
            &order,
            "--session-name",
            SESSION_NAME,
            "--session-mode",
            mode,
        ];
        args.extend_from_slice(provider_args);
        world.run_vtb(&args).await;
        world.assert_vtb_ok("step add with session");
    }
    let finish_order = modes.len().to_string();
    world
        .run_vtb(&[
            "step",
            "add",
            "finish",
            "--workflow",
            &workflow_id,
            "--step-type",
            "finish",
            "--order",
            &finish_order,
            "--harness",
            "claude",
        ])
        .await;
    world.assert_vtb_ok("step add finish");

    let mut chain: Vec<String> = Vec::new();
    for name in STEP_NAMES.iter().take(modes.len()).chain(["finish"].iter()) {
        chain.push(step_id(world, &workflow_id, name).await);
    }
    for pair in chain.windows(2) {
        world
            .run_vtb(&["step", "update", &pair[0], "--transition-to", &pair[1]])
            .await;
        world.assert_vtb_ok("step update session transition");
    }

    // The authored session round-trips through the CLI.
    for (name, mode) in STEP_NAMES.iter().zip(&modes) {
        let id = step_id(world, &workflow_id, name).await;
        let step = world
            .run_vtb_json(&["step", "show", &id])
            .await
            .expect("step show JSON");
        assert_eq!(
            step["config"]["session"],
            json!({"name": SESSION_NAME, "mode": mode}),
            "{step}"
        );
    }
    world.step_id = Some(chain[0].clone());
}

#[when(expr = "the {string} session steps are scripted to succeed")]
pub async fn script_session_steps(world: &mut DaemonWorld, harness: String) {
    script_steps(world, &harness, false).await;
}

#[when(expr = "the {string} provider loses the conversation after the first session step")]
pub async fn script_session_steps_forgetting(world: &mut DaemonWorld, harness: String) {
    script_steps(world, &harness, true).await;
}

async fn script_steps(world: &mut DaemonWorld, harness: &str, forget_after_first: bool) {
    let workflow_id = world.workflow_id.clone().expect("workflow not created");
    for (index, name) in STEP_NAMES.iter().enumerate() {
        let Some(id) = try_step_id(world, &workflow_id, name).await else {
            continue;
        };
        let answer = format!("{name}-answer");
        let mut builder = match harness {
            "claude" => world
                .mock_response(name)
                .with_stdout_line(liquid_safe(json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "result": answer,
                    "session_id": "replaced-by-mock",
                    "usage": {"input_tokens": 10, "output_tokens": 5}
                }))),
            "codex" => world
                .mock_response(name)
                .with_stdout_line(codex_notification(
                    "item/completed",
                    json!({"item": {"id": "m1", "type": "agentMessage", "text": answer}}),
                ))
                .with_stdout_line(codex_notification(
                    "turn/completed",
                    json!({"turn": {"status": "completed", "durationMs": 10}}),
                )),
            other => panic!("unsupported session harness {other:?}"),
        };
        if forget_after_first && index == 0 {
            builder = builder.with_forget_session();
        }
        let envelope = builder.build().expect("MockResponse envelope builds");
        world
            .run_vtb(&["step", "update", &id, "--prompt", &envelope])
            .await;
        world.assert_vtb_ok("step update --prompt");
    }
}

fn codex_notification(method: &str, params: Value) -> String {
    liquid_safe(json!({"method": method, "params": params}))
}

/// Sacrum treats `}}` as a Liquid trigger in the prompt-borne envelope; the
/// spaced form is the same JSON.
fn liquid_safe(value: Value) -> String {
    let mut encoded = value.to_string();
    while encoded.contains("}}") {
        encoded = encoded.replace("}}", "} }");
    }
    encoded
}

#[when(expr = "I wait for session step {string} to reach status {string}")]
pub async fn wait_for_session_step(world: &mut DaemonWorld, name: String, status: String) {
    let deadline = Instant::now() + SESSION_TIMEOUT;
    loop {
        let executions = session_executions(world).await;
        if executions
            .iter()
            .any(|execution| execution["step_name"] == name && execution["status"] == status)
        {
            return;
        }
        if Instant::now() >= deadline {
            panic!("session step {name:?} did not reach {status:?}: {executions:#?}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[then("the Claude session steps started and then resumed one conversation")]
pub async fn claude_started_then_resumed(world: &mut DaemonWorld) {
    let launches = claude_launches(world);
    assert_eq!(
        launches.len(),
        2,
        "expected two Claude launches: {launches:?}"
    );
    let started = flag_value(&launches[0], "--session-id")
        .unwrap_or_else(|| panic!("first launch did not pass --session-id: {:?}", launches[0]));
    assert!(resume_id(&launches[0]).is_none(), "{:?}", launches[0]);
    assert_eq!(
        resume_id(&launches[1]).as_deref(),
        Some(started.as_str()),
        "second launch must resume the first conversation: {:?}",
        launches[1]
    );
    assert!(flag_value(&launches[1], "--session-id").is_none());

    let first = completed_execution(world, "first").await;
    let second = completed_execution(world, "second").await;
    assert_eq!(first["native_session_id"], started.as_str(), "{first}");
    assert_eq!(second["native_session_id"], started.as_str(), "{second}");
    assert_eq!(first["session_name"], SESSION_NAME);
    assert_eq!(second["session_name"], SESSION_NAME);
    assert!(
        second["output"]
            .as_str()
            .is_some_and(|output| output.contains("second-answer")),
        "{second}"
    );
}

#[then("the Codex session steps started and then resumed one thread")]
pub async fn codex_started_then_resumed(world: &mut DaemonWorld) {
    let requests = world.captured_codex_requests();
    let starts = rpc_params(&requests, "thread/start");
    let resumes = rpc_params(&requests, "thread/resume");
    assert_eq!(starts.len(), 1, "expected one thread/start: {requests:#?}");
    assert_eq!(
        resumes.len(),
        1,
        "expected one thread/resume: {requests:#?}"
    );

    let first = completed_execution(world, "first").await;
    let second = completed_execution(world, "second").await;
    let thread_id = first["native_session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("first step recorded no native session id: {first}"));
    assert_eq!(resumes[0]["threadId"], thread_id, "{:#?}", resumes[0]);
    assert_eq!(second["native_session_id"], thread_id, "{second}");

    let resume = &resumes[0];
    assert_eq!(resume["model"], "gpt-5.5", "{resume:#}");
    assert!(resume.get("effort").is_none(), "{resume:#}");
    assert!(resume.get("developerInstructions").is_none(), "{resume:#}");

    let resume_index = requests
        .iter()
        .position(|request| request["method"] == "thread/resume")
        .expect("thread/resume captured");
    let resumed_turn = requests[resume_index..]
        .iter()
        .find(|request| request["method"] == "turn/start")
        .unwrap_or_else(|| panic!("no turn/start after thread/resume: {requests:#?}"));
    assert_eq!(resumed_turn["params"]["effort"], "high", "{resumed_turn:#}");
}

#[then("the Claude session step started a new conversation")]
pub async fn claude_started_new(world: &mut DaemonWorld) {
    let launches = claude_launches(world);
    assert_eq!(
        launches.len(),
        1,
        "expected one Claude launch: {launches:?}"
    );
    let started = flag_value(&launches[0], "--session-id")
        .unwrap_or_else(|| panic!("launch did not pass --session-id: {:?}", launches[0]));
    assert!(resume_id(&launches[0]).is_none(), "{:?}", launches[0]);
    let first = completed_execution(world, "first").await;
    assert_eq!(first["native_session_id"], started.as_str(), "{first}");
}

#[then("no provider was launched")]
pub async fn no_provider_launched(world: &mut DaemonWorld) {
    let launches = claude_launches(world);
    assert!(launches.is_empty(), "provider launched: {launches:?}");
    let executions = session_executions(world).await;
    assert!(
        executions.is_empty(),
        "dispatch failure should create no execution: {executions:#?}"
    );
}

/// Sacrum reports an unresolvable session as `dispatch_failed` whose reason
/// is the session name.
#[then(expr = "the TaskRun outcome reason is {string}")]
pub async fn task_run_outcome_reason(world: &mut DaemonWorld, reason: String) {
    let task_id = world.task_id.clone().expect("task not created");
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::TASK_RUNS,
        &[vertebrae_sacrum_client::queries::executions::TASK_RUN_FIELDS],
    );
    let runs: Vec<Value> = client
        .execute(&query, json!({ "task_id": task_id }), "task_runs")
        .await
        .expect("task_runs query failed");
    assert!(
        runs.iter()
            .any(|run| run["outcome_kind"] == "dispatch_failed"
                && run["outcome_context"]["reason"] == reason.as_str()),
        "no dispatch_failed TaskRun with reason {reason:?}: {runs:#?}"
    );
}

#[then(expr = "the Claude resume failed with {string} without starting a new conversation")]
pub async fn claude_resume_rejected(world: &mut DaemonWorld, reason: String) {
    let launches = claude_launches(world);
    let started = flag_value(&launches[0], "--session-id")
        .unwrap_or_else(|| panic!("first launch did not pass --session-id: {:?}", launches[0]));
    let rest = &launches[1..];
    assert!(
        !rest.is_empty(),
        "the resume was never launched: {launches:?}"
    );
    for launch in rest {
        assert_eq!(
            resume_id(launch).as_deref(),
            Some(started.as_str()),
            "only resumes of the first conversation may follow: {launch:?}"
        );
        assert!(flag_value(launch, "--session-id").is_none(), "{launch:?}");
    }
    assert_failed_with(world, "second", &reason).await;
}

#[then(expr = "the Codex resume failed with {string} without starting a new thread")]
pub async fn codex_resume_rejected(world: &mut DaemonWorld, reason: String) {
    let requests = world.captured_codex_requests();
    assert_eq!(
        rpc_params(&requests, "thread/start").len(),
        1,
        "a rejected resume must not start a new thread: {requests:#?}"
    );
    assert!(
        !rpc_params(&requests, "thread/resume").is_empty(),
        "the resume was never requested: {requests:#?}"
    );
    assert_failed_with(world, "second", &reason).await;
}

#[then("the Claude mock was launched one-shot without session flags")]
pub async fn claude_one_shot_without_session(world: &mut DaemonWorld) {
    let launches = claude_launches(world);
    assert_eq!(
        launches.len(),
        1,
        "expected one Claude launch: {launches:?}"
    );
    let argv = &launches[0];
    assert!(argv.iter().any(|arg| arg == "--print"), "{argv:?}");
    assert!(
        !argv.iter().any(|arg| arg == "--input-format"),
        "one-shot launches take the prompt on argv: {argv:?}"
    );
    assert!(flag_value(argv, "--session-id").is_none(), "{argv:?}");
    assert!(resume_id(argv).is_none(), "{argv:?}");
}

#[then("the execution records no native session id")]
pub async fn execution_has_no_native_session(world: &mut DaemonWorld) {
    let execution_id = world
        .execution_id
        .clone()
        .expect("no execution id recorded");
    let executions = session_executions(world).await;
    let execution = executions
        .iter()
        .find(|execution| execution["id"] == execution_id.as_str())
        .unwrap_or_else(|| panic!("execution {execution_id} not found: {executions:#?}"));
    assert!(execution["native_session_id"].is_null(), "{execution}");
    assert!(execution["session_name"].is_null(), "{execution}");
}

async fn assert_failed_with(world: &DaemonWorld, name: &str, reason: &str) {
    let executions = session_executions(world).await;
    let failed: Vec<&Value> = executions
        .iter()
        .filter(|execution| execution["step_name"] == name && execution["status"] == "failed")
        .collect();
    assert!(
        !failed.is_empty(),
        "no failed {name:?} execution: {executions:#?}"
    );
    for execution in failed {
        assert!(
            execution["output"]
                .as_str()
                .is_some_and(|output| output.contains(reason)),
            "failed {name:?} execution does not report {reason:?}: {execution}"
        );
    }
}

async fn completed_execution(world: &DaemonWorld, name: &str) -> Value {
    session_executions(world)
        .await
        .into_iter()
        .find(|execution| execution["step_name"] == name && execution["status"] == "completed")
        .unwrap_or_else(|| panic!("no completed execution for session step {name:?}"))
}

async fn session_executions(world: &DaemonWorld) -> Vec<Value> {
    let task_id = world.task_id.clone().expect("task not created");
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let mut executions: Vec<Value> = client
        .execute(
            SESSION_EXECUTIONS,
            json!({ "task_id": task_id }),
            "step_executions",
        )
        .await
        .expect("step_executions query failed");
    executions.sort_by_key(|execution| execution["inserted_at"].as_str().map(str::to_owned));
    executions
}

/// Captured Claude run launches, in launch order. Version probes and other
/// non-run invocations are skipped.
fn claude_launches(world: &DaemonWorld) -> Vec<Vec<String>> {
    let path = world.capture_dir.join("argv.jsonl");
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    body.lines()
        .map(|line| serde_json::from_str::<Vec<String>>(line).expect("captured argv parses"))
        .filter(|argv| argv.iter().any(|arg| arg == "--output-format"))
        .collect()
}

fn flag_value(argv: &[String], flag: &str) -> Option<String> {
    argv.iter()
        .position(|arg| arg == flag)
        .and_then(|index| argv.get(index + 1).cloned())
}

fn resume_id(argv: &[String]) -> Option<String> {
    argv.iter()
        .find_map(|arg| arg.strip_prefix("--resume=").map(str::to_owned))
        .or_else(|| flag_value(argv, "--resume"))
}

fn rpc_params(requests: &[Value], method: &str) -> Vec<Value> {
    requests
        .iter()
        .filter(|request| request["method"] == method)
        .map(|request| request["params"].clone())
        .collect()
}

async fn try_step_id(world: &mut DaemonWorld, workflow_id: &str, name: &str) -> Option<String> {
    let steps = world
        .run_vtb_json(&["step", "list", workflow_id])
        .await
        .unwrap_or_else(|| panic!("step list failed: {}", world.last_stderr));
    steps.as_array().and_then(|items| {
        items
            .iter()
            .find(|step| step["name"].as_str() == Some(name))
            .and_then(|step| step["id"].as_str())
            .map(str::to_owned)
    })
}

async fn step_id(world: &mut DaemonWorld, workflow_id: &str, name: &str) -> String {
    try_step_id(world, workflow_id, name)
        .await
        .unwrap_or_else(|| panic!("step {name:?} not found in workflow {workflow_id}"))
}
