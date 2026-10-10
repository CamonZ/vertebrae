//! Route-owned session directives: a route decision chooses whether its
//! destination llm_inference step starts, resumes, or forks a provider
//! conversation. Scenarios author the directive through
//! `vtb step update --route-config` and assert on how the daemon launched the
//! provider mock and on the native session ids Sacrum recorded.

use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::DaemonWorld;
use crate::steps::codex_mocks::{completed_turn, notification, usage_updated};

const SESSION_TIMEOUT: Duration = Duration::from_secs(45);

const SESSION_EXECUTIONS: &str = r#"
    query SessionExecutions($task_id: Uuid4!) {
        step_executions(task_id: $task_id) {
            id
            step_name
            status
            output
            native_session_id
            resume_session_id
            inserted_at
        }
    }
"#;

fn verdict_schema() -> String {
    json!({
        "type": "object",
        "properties": {"verdict": {"type": "string", "enum": ["again", "done"]}},
        "required": ["verdict"],
        "additionalProperties": false
    })
    .to_string()
}

fn fixture(world: &DaemonWorld, role: &str) -> String {
    world
        .fixture_ids
        .get(role)
        .unwrap_or_else(|| panic!("no session workflow fixture {role:?}"))
        .clone()
}

fn is_codex(world: &DaemonWorld) -> bool {
    fixture(world, "harness") == "codex"
}

async fn add_step(world: &mut DaemonWorld, name: &str, extra: &[&str]) -> String {
    let workflow_id = world.workflow_id.clone().expect("workflow not created");
    let mut args = vec!["step", "add", name, "--workflow", &workflow_id];
    args.extend_from_slice(extra);
    world.run_vtb(&args).await;
    world.assert_vtb_ok(&format!("step add {name}"));
    world
        .last_stdout
        .trim()
        .strip_prefix("Created step: ")
        .unwrap_or_else(|| panic!("unexpected step add output: {}", world.last_stdout))
        .trim()
        .to_string()
}

async fn llm_step(world: &mut DaemonWorld, name: &str, harness: &str, order: &str) -> String {
    let schema = verdict_schema();
    let mut args = vec![
        "--order",
        order,
        "--harness",
        harness,
        "--output-schema",
        &schema,
    ];
    if harness == "codex" {
        args.extend([
            "--provider",
            "openai",
            "--model",
            "gpt-5.5",
            "--reasoning-effort",
            "high",
        ]);
    } else {
        args.extend(["--model", "claude-sonnet-4-6"]);
    }
    add_step(world, name, &args).await
}

/// work -> route -> {work, review, finish}; review -> finish. The route's
/// rules are authored per scenario.
#[given(expr = "a session workflow on the {string} harness")]
pub async fn given_session_workflow(world: &mut DaemonWorld, harness: String) {
    let name = format!("daemon-acc-session-{}", uuid::Uuid::new_v4().simple());
    world.run_vtb(&["workflow", "add", &name]).await;
    world.assert_vtb_ok("workflow add");
    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.workflow_id = Some(workflow_id.clone());
    world.created_workflow_ids.push(workflow_id);

    let work = llm_step(world, "work", &harness, "0").await;
    let route = add_step(
        world,
        "route",
        &[
            "--step-type",
            "route",
            "--order",
            "1",
            "--harness",
            "claude",
        ],
    )
    .await;
    let review = llm_step(world, "review", &harness, "2").await;
    let finish = add_step(
        world,
        "finish",
        &[
            "--step-type",
            "finish",
            "--order",
            "3",
            "--harness",
            "claude",
        ],
    )
    .await;

    for (from, to) in [
        (&work, vec![&route]),
        (&route, vec![&work, &review, &finish]),
        (&review, vec![&finish]),
    ] {
        let mut args = vec!["step", "update", from.as_str()];
        for target in to {
            args.extend(["--transition-to", target.as_str()]);
        }
        world.run_vtb(&args).await;
        world.assert_vtb_ok("step update --transition-to");
    }

    world.step_id = Some(work.clone());
    for (role, id) in [
        ("harness", harness),
        ("work", work),
        ("route", route),
        ("review", review),
        ("finish", finish),
    ] {
        world.fixture_ids.insert(role.to_string(), id);
    }
}

/// `session` is the directive JSON for the `again` decision, or `none` to
/// leave it out; the `done` decision always goes to finish.
#[given(expr = "the route sends {string} to {string} with session {string}")]
pub async fn given_route_session(
    world: &mut DaemonWorld,
    verdict: String,
    target: String,
    session: String,
) {
    let mut again = json!({
        "id": verdict,
        "when": {"ref": "previous_output.verdict", "op": "eq", "value": verdict},
        "transition": {"type": "intra_workflow", "step_id": fixture(world, &target)}
    });
    if session != "none" {
        again["session"] = serde_json::from_str(&session).expect("session directive JSON");
    }
    let route_config = json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [
            again,
            {
                "id": "done",
                "when": {"ref": "previous_output.verdict", "op": "eq", "value": "done"},
                "transition": {"type": "intra_workflow", "step_id": fixture(world, "finish")}
            }
        ]
    });
    let route = fixture(world, "route");
    world
        .run_vtb(&[
            "step",
            "update",
            &route,
            "--route-config",
            &route_config.to_string(),
        ])
        .await;
    world.assert_vtb_ok("step update --route-config");
}

fn answer(world: &DaemonWorld, label: &str, verdict: &str) -> daemon_acceptance::MockResponse {
    let output = json!({"verdict": verdict});
    let response = world.mock_response(label);
    if is_codex(world) {
        response
            .with_stdout_line(notification(
                "item/completed",
                json!({"item": {"id": "m1", "type": "agentMessage", "text": output.to_string()}}),
            ))
            .with_stdout_line(usage_updated(10, 5))
            .with_stdout_line(completed_turn())
    } else {
        response.with_stdout_line(format!(
            r#"{{"type":"result","subtype":"success","is_error":false,"duration_ms":1.0,"result":"{verdict}","structured_output":{output},"session_id":"echoed","usage":{{"input_tokens":1,"output_tokens":1}} }}"#
        ))
    }
}

async fn set_work_prompt(world: &mut DaemonWorld, response: daemon_acceptance::MockResponse) {
    let envelope = response.build().expect("MockResponse envelope builds");
    let work = fixture(world, "work");
    world
        .run_vtb(&["step", "update", &work, "--prompt", &envelope])
        .await;
    world.assert_vtb_ok("step update --prompt");
}

#[when(expr = "the work step answers {string} then {string}")]
pub async fn work_answers(world: &mut DaemonWorld, first: String, second: String) {
    let response =
        answer(world, "work-first", &first).followed_by(answer(world, "work-second", &second));
    set_work_prompt(world, response).await;
}

#[when(expr = "the work step answers {string} and its conversation is lost, then {string}")]
pub async fn work_answers_and_loses_conversation(
    world: &mut DaemonWorld,
    first: String,
    second: String,
) {
    let response = answer(world, "work-first", &first)
        .with_discarded_session()
        .followed_by(answer(world, "work-second", &second));
    set_work_prompt(world, response).await;
}

#[derive(Debug, Clone)]
struct SessionExecution {
    step_name: String,
    status: String,
    output: String,
    native_session_id: Option<String>,
}

async fn session_executions(world: &DaemonWorld) -> Vec<SessionExecution> {
    let task_id = world.task_id.as_ref().expect("task not created");
    let client = world.graphql_client.as_ref().expect("graphql client");
    let executions: Value = client
        .execute(
            SESSION_EXECUTIONS,
            json!({"task_id": task_id}),
            "step_executions",
        )
        .await
        .expect("step_executions query failed");
    let mut executions = executions
        .as_array()
        .expect("step_executions is an array")
        .clone();
    executions.sort_by_key(|execution| execution["inserted_at"].as_str().unwrap_or("").to_owned());
    executions
        .iter()
        .map(|execution| SessionExecution {
            step_name: execution["step_name"].as_str().unwrap_or("").to_owned(),
            status: execution["status"].as_str().unwrap_or("").to_owned(),
            output: match &execution["output"] {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            },
            native_session_id: execution["native_session_id"].as_str().map(str::to_owned),
        })
        .collect()
}

async fn work_executions(world: &DaemonWorld) -> Vec<SessionExecution> {
    session_executions(world)
        .await
        .into_iter()
        .filter(|execution| execution.step_name == "work")
        .collect()
}

#[when(expr = "I wait for {int} work execution(s) to reach status {string}")]
pub async fn wait_for_work_executions(world: &mut DaemonWorld, count: usize, status: String) {
    let deadline = Instant::now() + SESSION_TIMEOUT;
    loop {
        let executions = work_executions(world).await;
        if executions
            .iter()
            .filter(|execution| execution.status.eq_ignore_ascii_case(&status))
            .count()
            >= count
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {count} work executions with status {status:?}: {executions:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Claude launches of persistent step sessions, in order.
fn claude_launches(world: &DaemonWorld) -> Vec<Vec<String>> {
    let path = world.capture_dir.join("invocations.jsonl");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("no captured invocations at {}: {error}", path.display()))
        .lines()
        .map(|line| serde_json::from_str::<Vec<String>>(line).expect("invocation argv parses"))
        .filter(|argv| argv.iter().any(|arg| arg == "--input-format"))
        .collect()
}

fn flag_value(argv: &[String], flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    argv.iter().enumerate().find_map(|(index, arg)| {
        if arg == flag {
            argv.get(index + 1).cloned()
        } else {
            arg.strip_prefix(&prefix).map(str::to_owned)
        }
    })
}

fn codex_requests(world: &DaemonWorld, method: &str) -> Vec<Value> {
    world
        .captured_codex_requests()
        .into_iter()
        .filter(|request| request["method"] == method)
        .collect()
}

fn native_id(execution: &SessionExecution) -> String {
    execution
        .native_session_id
        .clone()
        .unwrap_or_else(|| panic!("execution recorded no native_session_id: {execution:?}"))
}

#[then("the first work execution started a new conversation")]
pub async fn first_work_started_new(world: &mut DaemonWorld) {
    let executions = work_executions(world).await;
    let native = native_id(&executions[0]);
    if is_codex(world) {
        let first_turn = &codex_requests(world, "turn/start")[0];
        assert_eq!(first_turn["params"]["threadId"], json!(native));
        assert!(!codex_requests(world, "thread/start").is_empty());
    } else {
        let launch = &claude_launches(world)[0];
        assert_eq!(
            flag_value(launch, "--session-id"),
            Some(native),
            "{launch:?}"
        );
        assert_eq!(flag_value(launch, "--resume"), None, "{launch:?}");
    }
}

#[then("the second work execution resumed the first conversation")]
pub async fn second_work_resumed_first(world: &mut DaemonWorld) {
    let executions = work_executions(world).await;
    let first = native_id(&executions[0]);
    assert_eq!(native_id(&executions[1]), first, "{executions:?}");
    if is_codex(world) {
        assert_eq!(codex_requests(world, "thread/start").len(), 1);
        let resumes = codex_requests(world, "thread/resume");
        assert_eq!(resumes.len(), 1, "{resumes:?}");
        let params = &resumes[0]["params"];
        assert_eq!(params["threadId"], json!(first));
        assert_eq!(params["model"], "gpt-5.5");
        assert!(params.get("effort").is_none(), "{params}");
        assert!(params.get("developerInstructions").is_none(), "{params}");
        let turns = codex_requests(world, "turn/start");
        let resumed_turn = &turns[1]["params"];
        assert_eq!(resumed_turn["threadId"], json!(first));
        assert_eq!(resumed_turn["effort"], "high");
    } else {
        let launches = claude_launches(world);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(flag_value(&launches[1], "--resume"), Some(first));
        assert_eq!(flag_value(&launches[1], "--session-id"), None);
    }
}

#[then("the second work execution started another new conversation")]
pub async fn second_work_started_new(world: &mut DaemonWorld) {
    let executions = work_executions(world).await;
    let first = native_id(&executions[0]);
    let second = native_id(&executions[1]);
    assert_ne!(first, second, "{executions:?}");
    let launches = claude_launches(world);
    assert_eq!(launches.len(), 2, "{launches:?}");
    assert_eq!(flag_value(&launches[1], "--session-id"), Some(second));
    assert_eq!(flag_value(&launches[1], "--resume"), None);
}

#[then(expr = "the later work executions failed with {string} without a new conversation")]
pub async fn resumed_work_failed(world: &mut DaemonWorld, reason: String) {
    let executions = work_executions(world).await;
    let first = native_id(&executions[0]);
    assert_eq!(executions[0].status, "completed", "{executions:?}");
    assert!(executions.len() >= 2, "{executions:?}");
    for execution in &executions[1..] {
        assert_eq!(execution.status, "failed", "{execution:?}");
        assert!(
            execution.output.contains(&reason) && execution.output.contains(&first),
            "expected {reason:?} for {first} in {execution:?}"
        );
    }
    if is_codex(world) {
        assert_eq!(codex_requests(world, "thread/start").len(), 1);
        assert!(
            codex_requests(world, "thread/resume")
                .iter()
                .all(|request| request["params"]["threadId"] == json!(first))
        );
        assert_eq!(codex_requests(world, "turn/start").len(), 1);
    } else {
        let launches = claude_launches(world);
        assert_eq!(
            launches
                .iter()
                .filter(|argv| flag_value(argv, "--session-id").is_some())
                .count(),
            1,
            "{launches:?}"
        );
        assert!(
            launches[1..]
                .iter()
                .all(|argv| flag_value(argv, "--resume").as_deref() == Some(first.as_str())),
            "{launches:?}"
        );
    }
}

#[then("the TaskRun failure names the review step")]
pub async fn task_run_failure_names_review(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created");
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::TASK_RUNS,
        &[vertebrae_sacrum_client::queries::executions::TASK_RUN_FIELDS],
    );
    let runs: Value = world
        .graphql_client
        .as_ref()
        .expect("graphql client")
        .execute(&query, json!({"task_id": task_id}), "task_runs")
        .await
        .expect("task_runs query failed");
    let review = fixture(world, "review");
    assert!(
        runs.as_array()
            .expect("task_runs is an array")
            .iter()
            .any(|run| {
                run["outcome_kind"] == "dispatch_failed"
                    && run["outcome_context"]["reason"] == json!(review)
            }),
        "expected a dispatch_failed TaskRun naming review step {review}: {runs}"
    );
}

#[then("the review step was never dispatched and the provider ran once")]
pub async fn review_never_dispatched(world: &mut DaemonWorld) {
    let executions = session_executions(world).await;
    assert!(
        executions
            .iter()
            .all(|execution| execution.step_name != "review"),
        "{executions:?}"
    );
    if is_codex(world) {
        assert_eq!(codex_requests(world, "turn/start").len(), 1);
    } else {
        assert_eq!(claude_launches(world).len(), 1);
    }
}
