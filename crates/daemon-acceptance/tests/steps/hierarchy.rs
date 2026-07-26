//! Parent/child orchestration steps.
//!
//! These steps build workflows and tasks for the wait_children scenarios:
//! - a reusable child workflow with an `execute` step followed by an explicit
//!   `finish` step that the mock claude drives to completion,
//! - a parent workflow with `wait_children` -> `work` (both mock-claude
//!   scripted) -> `finish` so the parent finishes after the work step,
//! - parent/child/grandchild tasks wired via `vtb add --parent` and
//!   assigned to the appropriate workflows.
//!
//! Orchestration is triggered via the `orchestrate_task` GraphQL mutation
//! (not `vtb run`), because wait_children is handled server-side by
//! Sacrum's TaskOrchestrator rather than by the daemon.

use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use daemon_acceptance::MockResponse;

use crate::DaemonWorld;

const CHILD_COMPLETION_TIMEOUT: Duration = Duration::from_secs(60);
const PARENT_WAIT_RESOLVED_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

// ===== GIVEN =====

#[given("a child execute workflow that succeeds via mock claude")]
pub async fn child_execute_workflow(world: &mut DaemonWorld) {
    let wf_name = format!("daemon-acc-child-wf-{}", uuid::Uuid::new_v4().simple());
    world
        .run_vtb(&[
            "workflow",
            "add",
            &wf_name,
            "--step",
            "run:claude-sonnet-4-6",
            "--step",
            "finish:claude-sonnet-4-6",
        ])
        .await;
    world.assert_vtb_ok("workflow add (child)");
    let wf_id = parse_created_workflow_id(&world.last_stdout);
    world.child_workflow_id = Some(wf_id.clone());
    world.created_workflow_ids.push(wf_id.clone());

    let step_id = step_id_by_name(world, &wf_id, "run").await;
    let finish_step_id = step_id_by_name(world, &wf_id, "finish").await;

    world
        .run_vtb(&["step", "update", &finish_step_id, "--step-type", "finish"])
        .await;
    world.assert_vtb_ok("child finish step update --step-type finish");

    // Script the mock to exit 0 with a valid stream-json result line. The
    // same fixture is reused across every child; they all share the same
    // step definition.
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.001,"duration_ms":5.0,"is_error":false,"result":"child-ok","session_id":"sess-child","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let envelope = MockResponse::new(
        world.mock_output_dir.clone(),
        &world.feature_slug,
        &world.scenario_slug,
        "child",
    )
    .with_exit_code(0)
    .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-child"}"#)
    .with_stdout_line(result_line)
    .build()
    .expect("child mock envelope builds");

    world
        .run_vtb(&["step", "update", &step_id, "--prompt", &envelope])
        .await;
    world.assert_vtb_ok("child step update --prompt");
}

#[given("a parent wait_children workflow with a work step")]
pub async fn parent_wait_children_workflow(world: &mut DaemonWorld) {
    let wf_id = create_wait_children_workflow(world, "parent").await;
    world.workflow_id = Some(wf_id.clone());
    world.parent_workflow_id = Some(wf_id);
}

#[given("a parent task assigned to the parent workflow")]
pub async fn parent_task_assigned(world: &mut DaemonWorld) {
    let wf_id = require(&world.parent_workflow_id, "parent workflow not created");

    let task_id = create_task(world, "daemon-acc-parent", None).await;
    world.task_id = Some(task_id.clone());
    world.parent_task_id = Some(task_id.clone());

    world
        .run_vtb(&["workflow", "assign", &task_id, &wf_id])
        .await;
    world.assert_vtb_ok("workflow assign (parent)");
}

#[given(expr = "{int} child tasks assigned to the child workflow")]
pub async fn n_child_tasks(world: &mut DaemonWorld, n: usize) {
    let parent_id = require(&world.parent_task_id, "parent task not created");
    let child_wf = require(&world.child_workflow_id, "child workflow not created");

    for i in 0..n {
        let title = format!("daemon-acc-child-{i}");
        let child_id = create_task(world, &title, Some(&parent_id)).await;
        world
            .run_vtb(&["workflow", "assign", &child_id, &child_wf])
            .await;
        world.assert_vtb_ok("workflow assign (child)");
        world.child_task_ids.push(child_id);
    }
}

#[given(expr = "{int} dependency-ordered child tasks assigned to the child workflow")]
pub async fn n_dependency_ordered_children(world: &mut DaemonWorld, n: usize) {
    let parent_id = require(&world.parent_task_id, "parent task not created");
    let child_wf = require(&world.child_workflow_id, "child workflow not created");

    let mut previous_id: Option<String> = None;
    for i in 0..n {
        let title = format!("daemon-acc-ord-child-{i}");
        let child_id = create_task(world, &title, Some(&parent_id)).await;
        world
            .run_vtb(&["workflow", "assign", &child_id, &child_wf])
            .await;
        world.assert_vtb_ok("workflow assign (ordered child)");

        if let Some(prev) = &previous_id {
            world.run_vtb(&["depend", &child_id, "--on", prev]).await;
            world.assert_vtb_ok("depend");
        }

        previous_id = Some(child_id.clone());
        world.child_task_ids.push(child_id);
    }
}

#[given("1 intermediate child assigned to a wait_children workflow")]
pub async fn intermediate_wait_children(world: &mut DaemonWorld) {
    let parent_id = require(&world.parent_task_id, "parent task not created");

    let wf_id = create_wait_children_workflow(world, "intermediate").await;

    let child_id = create_task(world, "daemon-acc-intermediate", Some(&parent_id)).await;
    world
        .run_vtb(&["workflow", "assign", &child_id, &wf_id])
        .await;
    world.assert_vtb_ok("workflow assign (intermediate)");
    world.intermediate_task_id = Some(child_id.clone());
    world.child_task_ids.push(child_id);
}

#[given(expr = "{int} grandchildren under the intermediate child assigned to the child workflow")]
pub async fn n_grandchildren(world: &mut DaemonWorld, n: usize) {
    let inter_id = require(&world.intermediate_task_id, "intermediate task not created");
    let child_wf = require(&world.child_workflow_id, "child workflow not created");

    for i in 0..n {
        let title = format!("daemon-acc-grandchild-{i}");
        let gc_id = create_task(world, &title, Some(&inter_id)).await;
        world
            .run_vtb(&["workflow", "assign", &gc_id, &child_wf])
            .await;
        world.assert_vtb_ok("workflow assign (grandchild)");
        world.grandchild_task_ids.push(gc_id);
    }
}

// ===== WHEN =====

#[when("I orchestrate the parent task")]
pub async fn orchestrate_parent(world: &mut DaemonWorld) {
    let task_id = require(&world.parent_task_id, "parent task not set");
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();

    let query = r#"
        mutation OrchestrateTask($task_id: Uuid4!) {
            orchestrate_task(task_id: $task_id) { id }
        }
    "#;
    let _: serde_json::Value = client
        .execute(
            query,
            serde_json::json!({ "task_id": task_id }),
            "orchestrate_task",
        )
        .await
        .expect("orchestrate_task mutation failed");
}

#[when("I wait for all children to reach completion")]
pub async fn wait_all_children_complete(world: &mut DaemonWorld) {
    assert!(!world.child_task_ids.is_empty(), "no children to wait for");
    wait_for_tasks_completed(
        world,
        &world.child_task_ids.clone(),
        CHILD_COMPLETION_TIMEOUT,
    )
    .await;
}

#[when("I wait for all grandchildren to reach completion")]
pub async fn wait_all_grandchildren_complete(world: &mut DaemonWorld) {
    assert!(
        !world.grandchild_task_ids.is_empty(),
        "no grandchildren to wait for"
    );
    wait_for_tasks_completed(
        world,
        &world.grandchild_task_ids.clone(),
        CHILD_COMPLETION_TIMEOUT,
    )
    .await;
}

#[when(expr = "I wait for the parent waiting execution to reach status {string}")]
pub async fn wait_parent_waiting_status(world: &mut DaemonWorld, target: String) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    let exec_id = wait_for_waiting_execution(world, &parent_id, PARENT_WAIT_RESOLVED_TIMEOUT).await;
    world
        .poll_execution(&exec_id, &[&target], PARENT_WAIT_RESOLVED_TIMEOUT)
        .await
        .expect("parent waiting execution did not reach target status");
}

// ===== THEN =====

#[then("every child task is completed")]
pub async fn every_child_completed(world: &mut DaemonWorld) {
    assert_all_tasks_completed(world, &world.child_task_ids.clone(), "child").await;
}

#[then("every grandchild task is completed")]
pub async fn every_grandchild_completed(world: &mut DaemonWorld) {
    assert_all_tasks_completed(world, &world.grandchild_task_ids.clone(), "grandchild").await;
}

#[then(expr = "the parent's waiting execution has status {string}")]
pub async fn parent_waiting_status_is(world: &mut DaemonWorld, expected: String) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    assert_wait_children_status(world, &parent_id, &expected, "parent").await;
}

#[then(expr = "the intermediate child's waiting execution has status {string}")]
pub async fn intermediate_waiting_status_is(world: &mut DaemonWorld, expected: String) {
    let inter_id = require(&world.intermediate_task_id, "intermediate not set");
    assert_wait_children_status(world, &inter_id, &expected, "intermediate").await;
}

#[then("the parent task has a completed step execution for the work step")]
pub async fn parent_has_work_completed(world: &mut DaemonWorld) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    wait_for_completed_step_execution(world, &parent_id, "work", PARENT_WAIT_RESOLVED_TIMEOUT)
        .await;
}

#[then("the parent task is done")]
pub async fn parent_task_is_done(world: &mut DaemonWorld) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    wait_for_tasks_completed(
        world,
        std::slice::from_ref(&parent_id),
        PARENT_WAIT_RESOLVED_TIMEOUT,
    )
    .await;
}

#[then("the parent wait_children step was handled without daemon dispatch")]
pub async fn no_dispatch_for_wait_children(world: &mut DaemonWorld) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    let execs = list_task_executions(world, &parent_id).await;
    // A wait_children execution is orchestrator-driven: it goes from
    // `waiting` straight to `completed` (on satisfied wait) or
    // `invalidated` (on inter-workflow supersession), without entering
    // `pending` / `in_progress`. Sacrum may now populate an output payload
    // when resolving the wait; duration_ms remains daemon-owned and would
    // imply a run_step dispatch.
    for e in &execs {
        if step_name(e) != Some("wait_children") {
            continue;
        }
        let status = e.get("status").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            matches!(status, "waiting" | "completed" | "invalidated"),
            "wait_children execution has unexpected status {status:?}: {e}"
        );
        assert!(
            e.get("duration_ms").and_then(|v| v.as_i64()).is_none(),
            "wait_children execution has duration_ms (implies a dispatch): {e}"
        );
    }
}

#[then(expr = "child {int} completed before child {int} started")]
pub async fn child_completed_before_child_started(
    world: &mut DaemonWorld,
    earlier: usize,
    later: usize,
) {
    let (earlier_id, earlier_end) = child_run_end(world, earlier).await;
    let (later_id, later_start) = child_run_start(world, later).await;
    assert!(
        earlier_end.as_str() <= later_start.as_str(),
        "expected child {earlier} ({earlier_id}) to complete (at {earlier_end}) before child {later} ({later_id}) starts (at {later_start})"
    );
}

#[then(expr = "the parent's wait_children execution started before child {int} started")]
pub async fn parent_waited_before_child(world: &mut DaemonWorld, n: usize) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    let waiting = find_wait_children_execution(world, &parent_id).await;
    let waiting_start = str_field(&waiting, "inserted_at").to_string();
    let (child_id, child_start) = child_run_start(world, n).await;
    assert!(
        !waiting_start.is_empty(),
        "parent wait_children execution missing inserted_at: {waiting}"
    );
    assert!(
        waiting_start.as_str() <= child_start.as_str(),
        "expected parent to park (at {waiting_start}) before child {n} ({child_id}) starts (at {child_start})"
    );
}

#[then(expr = "the parent's work execution started after child {int} completed")]
pub async fn parent_work_started_after_child(world: &mut DaemonWorld, n: usize) {
    let parent_id = require(&world.parent_task_id, "parent task not set");
    let execs = list_task_executions(world, &parent_id).await;
    let work = execs
        .iter()
        .find(|e| step_name(e) == Some("work"))
        .unwrap_or_else(|| panic!("parent has no work execution: {execs:?}"));
    let work_start = str_field(work, "inserted_at").to_string();
    let (child_id, child_end) = child_run_end(world, n).await;
    assert!(
        !work_start.is_empty(),
        "parent work execution missing inserted_at: {work}"
    );
    assert!(
        child_end.as_str() <= work_start.as_str(),
        "expected parent work to start (at {work_start}) after child {n} ({child_id}) completes (at {child_end})"
    );
}

// ===== helpers =====

fn require(opt: &Option<String>, msg: &str) -> String {
    opt.as_ref().unwrap_or_else(|| panic!("{msg}")).clone()
}

fn step_name(exec: &serde_json::Value) -> Option<&str> {
    exec.get("step_name").and_then(|v| v.as_str())
}

fn str_field<'a>(exec: &'a serde_json::Value, key: &str) -> &'a str {
    exec.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn status_eq(exec: &serde_json::Value, expected: &str) -> bool {
    str_field(exec, "status").eq_ignore_ascii_case(expected)
}

async fn create_wait_children_workflow(world: &mut DaemonWorld, label: &str) -> String {
    let wf_name = format!("daemon-acc-{label}-wf-{}", uuid::Uuid::new_v4().simple());
    // Three steps: wait_children parks the parent; work runs post-resume;
    // finish terminates the task without daemon dispatch.
    world
        .run_vtb(&[
            "workflow",
            "add",
            &wf_name,
            "--step",
            "wait_children:claude-sonnet-4-6",
            "--step",
            "work:claude-sonnet-4-6",
            "--step",
            "finish:claude-sonnet-4-6",
        ])
        .await;
    world.assert_vtb_ok("workflow add (parent/intermediate)");
    let wf_id = parse_created_workflow_id(&world.last_stdout);
    world.created_workflow_ids.push(wf_id.clone());

    let wait_step_id = step_id_by_name(world, &wf_id, "wait_children").await;
    let work_step_id = step_id_by_name(world, &wf_id, "work").await;
    let finish_step_id = step_id_by_name(world, &wf_id, "finish").await;

    world
        .run_vtb(&[
            "step",
            "update",
            &wait_step_id,
            "--step-type",
            "wait_children",
        ])
        .await;
    world.assert_vtb_ok("step update --step-type wait_children");

    world
        .run_vtb(&["step", "update", &finish_step_id, "--step-type", "finish"])
        .await;
    world.assert_vtb_ok("step update finish --step-type finish");

    // Script mock-claude for the work step so the post-wait dispatch
    // succeeds. Labeled by workflow role so parent and intermediate don't
    // share fixture paths.
    let work_label = format!("{label}-work");
    let result_line = format!(
        r#"{{"type":"result","subtype":"success","cost_usd":0.001,"duration_ms":5.0,"is_error":false,"result":"{label}-work-ok","session_id":"sess-{label}-work","usage":{{"input_tokens":1,"output_tokens":1}} }}"#
    );
    let init_line =
        format!(r#"{{"type":"system","subtype":"init","session_id":"sess-{label}-work"}}"#);
    let envelope = MockResponse::new(
        world.mock_output_dir.clone(),
        &world.feature_slug,
        &world.scenario_slug,
        &work_label,
    )
    .with_exit_code(0)
    .with_stdout_line(&init_line)
    .with_stdout_line(&result_line)
    .build()
    .expect("work mock envelope builds");

    world
        .run_vtb(&["step", "update", &work_step_id, "--prompt", &envelope])
        .await;
    world.assert_vtb_ok("step update work --prompt");

    wf_id
}

async fn step_id_by_name(world: &mut DaemonWorld, wf_id: &str, name: &str) -> String {
    let json = world
        .run_vtb_json(&["step", "list", wf_id])
        .await
        .expect("step list JSON");
    let arr = json.as_array().expect("array");
    let step = arr
        .iter()
        .find(|v| v["name"].as_str() == Some(name))
        .unwrap_or_else(|| panic!("step {name:?} not found: {arr:?}"));
    step["id"].as_str().unwrap().to_string()
}

async fn create_task(world: &mut DaemonWorld, title: &str, parent: Option<&str>) -> String {
    let mut args: Vec<&str> = vec!["add", title];
    if let Some(p) = parent {
        args.push("--parent");
        args.push(p);
    }
    world.run_vtb(&args).await;
    world.assert_vtb_ok("task add");
    let id = world
        .last_stdout
        .trim()
        .strip_prefix("Created task: ")
        .unwrap_or_else(|| panic!("unexpected task output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.created_task_ids.push(id.clone());
    id
}

fn parse_created_workflow_id(stdout: &str) -> String {
    stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {stdout}"))
        .trim()
        .to_string()
}

async fn fetch_task(world: &DaemonWorld, task_id: &str) -> serde_json::Value {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::tasks::GET_TASK,
        &[vertebrae_sacrum_client::queries::tasks::TASK_FIELDS],
    );
    client
        .execute(&query, serde_json::json!({ "id": task_id }), "task")
        .await
        .expect("task query failed")
}

async fn list_task_executions(world: &DaemonWorld, task_id: &str) -> Vec<serde_json::Value> {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    let resp: serde_json::Value = client
        .execute(
            &query,
            serde_json::json!({ "task_id": task_id }),
            "step_executions",
        )
        .await
        .expect("list executions failed");
    resp.as_array().cloned().unwrap_or_default()
}

fn task_completed_at(task: &serde_json::Value) -> &str {
    str_field(task, "completed_at")
}

async fn assert_all_tasks_completed(world: &DaemonWorld, ids: &[String], kind: &str) {
    for id in ids {
        let task = fetch_task(world, id).await;
        assert!(
            !task_completed_at(&task).is_empty(),
            "{kind} {id} has no completed_at: {task}"
        );
    }
}

async fn assert_wait_children_status(
    world: &DaemonWorld,
    task_id: &str,
    expected: &str,
    label: &str,
) {
    let execs = list_task_executions(world, task_id).await;
    let waiting = execs
        .iter()
        .find(|e| step_name(e) == Some("wait_children") && status_eq(e, expected))
        .unwrap_or_else(|| {
            panic!("{label} has no wait_children execution with status={expected}: {execs:?}")
        });
    let actual = str_field(waiting, "status");
    assert!(
        actual.eq_ignore_ascii_case(expected),
        "expected {label} waiting execution status={expected}, got {actual}"
    );
}

async fn child_run_start(world: &DaemonWorld, n: usize) -> (String, String) {
    let (id, run) = child_run_execution(world, n).await;
    (id, str_field(&run, "inserted_at").to_string())
}

/// Returns the child task's `completed_at` time. The step-execution
/// `updated_at` is unreliable for cross-task ordering because Sacrum can
/// flush the next child's dispatch before the prior child's execution row
/// has been updated; the *task*-level `completed_at` is set only after the
/// whole child workflow wraps up, making it monotonic with downstream
/// dispatches.
async fn child_run_end(world: &DaemonWorld, n: usize) -> (String, String) {
    assert!(n >= 1, "child indices are 1-based");
    let idx = n - 1;
    let id = world
        .child_task_ids
        .get(idx)
        .unwrap_or_else(|| panic!("child {n} out of range: {:?}", world.child_task_ids))
        .clone();
    let task = fetch_task(world, &id).await;
    let completed_at = task_completed_at(&task).to_string();
    assert!(
        !completed_at.is_empty(),
        "child {n} ({id}) task has no completed_at: {task}"
    );
    (id, completed_at)
}

async fn child_run_execution(world: &DaemonWorld, n: usize) -> (String, serde_json::Value) {
    assert!(n >= 1, "child indices are 1-based");
    let idx = n - 1;
    let id = world
        .child_task_ids
        .get(idx)
        .unwrap_or_else(|| panic!("child {n} out of range: {:?}", world.child_task_ids))
        .clone();
    let execs = list_task_executions(world, &id).await;
    let run = execs
        .iter()
        .find(|e| step_name(e) == Some("run"))
        .unwrap_or_else(|| panic!("child {n} ({id}) has no run execution: {execs:?}"))
        .clone();
    let inserted = str_field(&run, "inserted_at");
    let updated = str_field(&run, "updated_at");
    assert!(
        !inserted.is_empty() && !updated.is_empty(),
        "child {n} ({id}) execution missing timestamps: {run}"
    );
    (id, run)
}

async fn find_wait_children_execution(world: &DaemonWorld, task_id: &str) -> serde_json::Value {
    let execs = list_task_executions(world, task_id).await;
    execs
        .iter()
        .find(|e| step_name(e) == Some("wait_children"))
        .unwrap_or_else(|| panic!("task {task_id} has no wait_children execution: {execs:?}"))
        .clone()
}

async fn wait_for_tasks_completed(world: &DaemonWorld, ids: &[String], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let mut pending: Option<String> = None;
        for id in ids {
            let task = fetch_task(world, id).await;
            if task_completed_at(&task).is_empty() {
                pending = Some(id.clone());
                break;
            }
        }
        if pending.is_none() {
            return;
        }
        if Instant::now() >= deadline {
            let id = pending.unwrap_or_default();
            panic!(
                "timed out after {timeout:?} waiting for tasks {ids:?} to complete (task {id} has no completed_at yet)"
            );
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Poll until a step execution with the given `step_name` reaches the
/// `completed` status on the task. The work execution arrives after Sacrum
/// has advanced past `wait_children` AND the daemon has finished the
/// downstream dispatch, so we can't read it in a single shot right after
/// the waiting execution flips.
async fn wait_for_completed_step_execution(
    world: &DaemonWorld,
    task_id: &str,
    step_name_expected: &str,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
    loop {
        let execs = list_task_executions(world, task_id).await;
        let completed = execs
            .iter()
            .any(|e| step_name(e) == Some(step_name_expected) && status_eq(e, "completed"));
        if completed {
            return;
        }
        if Instant::now() >= deadline {
            panic!(
                "timed out after {timeout:?} waiting for completed {step_name_expected:?} execution on task {task_id}: {execs:?}"
            );
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn wait_for_waiting_execution(
    world: &DaemonWorld,
    task_id: &str,
    timeout: Duration,
) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        let execs = list_task_executions(world, task_id).await;
        if let Some(e) = execs.iter().find(|e| step_name(e) == Some("wait_children"))
            && let Some(id) = e.get("id").and_then(|v| v.as_str())
        {
            return id.to_string();
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for wait_children execution on {task_id}: {execs:?}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
