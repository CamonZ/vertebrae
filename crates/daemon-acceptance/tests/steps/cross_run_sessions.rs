//! Session directives that reach a linked run: an inter_workflow route
//! decision resumes a conversation of the route's workflow in the same
//! TaskRun, the edge leaving a stop step resumes the conversation of the run
//! that stopped there, and a wait_children step's children fork the parent
//! run's conversation. Scenarios assert on how the daemon launched the
//! provider mock (the run_step session it received) and on the conversation
//! lineage Sacrum recorded.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::DaemonWorld;
use crate::steps::hierarchy::create_task;
use crate::steps::sessions::{
    add_step, add_step_to, answer, claude_launches, codex_requests, create_session_workflow,
    fixture, flag_value, llm_step, llm_step_in, set_prompt,
};
use crate::steps::stop::list_task_runs;

const RUN_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

const SESSION_LINEAGE: &str = r#"
    query SessionLineage($task_id: Uuid4!) {
        step_executions(task_id: $task_id) {
            id
            step_name
            status
            inserted_at
            native_session_id
            resume_session_id
            conversation_root_execution_id
            forked_from_execution_id
            task_run { id }
        }
    }
"#;

/// One execution's conversation lineage.
#[derive(Debug, Clone)]
struct Turn {
    id: String,
    step_name: String,
    native: Option<String>,
    resume: Option<String>,
    root: Option<String>,
    forked_from: Option<String>,
    task_run_id: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

async fn turns(world: &DaemonWorld, task_id: &str) -> Vec<Turn> {
    let executions: Value = world
        .graphql_client
        .as_ref()
        .expect("graphql client")
        .execute(
            SESSION_LINEAGE,
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
        .map(|execution| Turn {
            id: text(&execution["id"]).expect("execution id"),
            step_name: text(&execution["step_name"]).unwrap_or_default(),
            native: text(&execution["native_session_id"]),
            resume: text(&execution["resume_session_id"]),
            root: text(&execution["conversation_root_execution_id"]),
            forked_from: text(&execution["forked_from_execution_id"]),
            task_run_id: text(&execution["task_run"]["id"]),
        })
        .collect()
}

/// The single execution of `step_name` on `task_id`.
async fn turn(world: &DaemonWorld, task_id: &str, step_name: &str) -> Turn {
    let all = turns(world, task_id).await;
    let matching: Vec<_> = all
        .iter()
        .filter(|turn| turn.step_name == step_name)
        .cloned()
        .collect();
    assert_eq!(matching.len(), 1, "one {step_name} execution: {all:?}");
    matching.into_iter().next().unwrap()
}

fn native(turn: &Turn) -> String {
    turn.native
        .clone()
        .unwrap_or_else(|| panic!("execution recorded no native_session_id: {turn:?}"))
}

fn task_id(world: &DaemonWorld) -> String {
    world.task_id.clone().expect("task not created")
}

fn is_codex(world: &DaemonWorld) -> bool {
    fixture(world, "harness") == "codex"
}

async fn new_workflow(world: &mut DaemonWorld, label: &str) -> String {
    let name = format!("daemon-acc-{label}-{}", uuid::Uuid::new_v4().simple());
    world.run_vtb(&["workflow", "add", &name]).await;
    world.assert_vtb_ok("workflow add");
    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.created_workflow_ids.push(workflow_id.clone());
    workflow_id
}

async fn typed_step(
    world: &mut DaemonWorld,
    workflow_id: &str,
    name: &str,
    step_type: &str,
    order: &str,
) -> String {
    add_step_to(
        world,
        workflow_id,
        name,
        &[
            "--step-type",
            step_type,
            "--order",
            order,
            "--harness",
            "claude",
        ],
    )
    .await
}

async fn link(world: &mut DaemonWorld, from: &str, to: &str, session: Option<String>) {
    let mut args = vec!["step", "update", from, "--transition-to", to];
    let session = session.map(|directive| format!("{to}={directive}"));
    if let Some(session) = &session {
        args.extend(["--transition-session", session.as_str()]);
    }
    world.run_vtb(&args).await;
    world.assert_vtb_ok("step update --transition-to");
}

/// The entry step of a destination or child workflow: an llm_inference step
/// that answers `done`, or a `human_input` gate.
async fn entry_step(
    world: &mut DaemonWorld,
    workflow_id: &str,
    entry: &str,
    harness: &str,
    role: &str,
) -> String {
    let step = match entry {
        "llm_inference" => llm_step_in(world, workflow_id, role, harness, "0").await,
        "human_input" => typed_step(world, workflow_id, role, "human_input", "0").await,
        other => panic!("unsupported entry step type {other:?}"),
    };
    let finish = typed_step(world, workflow_id, &format!("{role}-finish"), "finish", "1").await;
    link(world, &step, &finish, None).await;
    world.fixture_ids.insert(role.to_string(), step.clone());
    if entry == "llm_inference" {
        let response = answer(world, role, "done");
        set_prompt(world, role, response).await;
    }
    step
}

// ===== Given =====

/// work -> route; the route's only decision hands off to a second workflow
/// whose entry step is `entry` (named `followup` or `gate`), resuming work's
/// conversation.
#[given(
    expr = "a handoff workflow on the {string} harness whose route resumes work into a {word} entry step"
)]
pub async fn given_handoff_workflow(world: &mut DaemonWorld, harness: String, entry: String) {
    create_session_workflow(world).await;
    world
        .fixture_ids
        .insert("harness".to_string(), harness.clone());
    let source_workflow = world.workflow_id.clone().expect("workflow created");
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
    link(world, &work, &route, None).await;
    world.fixture_ids.insert("work".to_string(), work.clone());

    let destination = new_workflow(world, "handoff").await;
    let role = if entry == "llm_inference" {
        "followup"
    } else {
        "gate"
    };
    entry_step(world, &destination, &entry, &harness, role).await;
    world
        .run_vtb(&[
            "workflow",
            "transition",
            "add",
            &source_workflow,
            &destination,
            "--label",
            "handoff",
        ])
        .await;
    world.assert_vtb_ok("workflow transition add");

    // The default covers the verdict's other value; both hand off the same way.
    let handoff = json!({
        "transition": {"type": "inter_workflow", "workflow_id": destination},
        "session": {"mode": "resume", "step_id": work}
    });
    let mut rule = handoff.clone();
    rule["id"] = json!("handoff");
    rule["when"] = json!({"ref": "previous_output.verdict", "op": "eq", "value": "done"});
    let route_config = json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [rule],
        "default": handoff
    });
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

    let response = answer(world, "work", "done");
    set_prompt(world, "work", response).await;
    world.step_id = Some(work);
}

/// draft -> pause (stop) -> revise -> finish. `directive` is the pause ->
/// revise `--transition-session` value with step names in place of ids
/// (`resume:draft`).
#[given(
    expr = "a stop-boundary session workflow on the {string} harness whose pause -> revise edge carries {string}"
)]
pub async fn given_stop_boundary_session_workflow(
    world: &mut DaemonWorld,
    harness: String,
    directive: String,
) {
    create_session_workflow(world).await;
    world
        .fixture_ids
        .insert("harness".to_string(), harness.clone());
    let workflow_id = world.workflow_id.clone().expect("workflow created");
    let draft = llm_step(world, "draft", &harness, "0").await;
    let revise = llm_step(world, "revise", &harness, "2").await;
    let finish = typed_step(world, &workflow_id, "finish", "finish", "3").await;
    // A stop step is created with its single transition.
    let session = format!(
        "{revise}={}",
        directive
            .replace("draft", &draft)
            .replace("revise", &revise)
    );
    let pause = add_step(
        world,
        "pause",
        &[
            "--step-type",
            "stop",
            "--order",
            "1",
            "--harness",
            "claude",
            "--transition-to",
            &revise,
            "--transition-session",
            &session,
        ],
    )
    .await;
    link(world, &draft, &pause, None).await;
    link(world, &revise, &finish, None).await;

    for (role, id) in [("draft", draft.clone()), ("revise", revise)] {
        world.fixture_ids.insert(role.to_string(), id);
        let response = answer(world, role, "done");
        set_prompt(world, role, response).await;
    }
    world.step_id = Some(draft);
}

/// plan -> wait (wait_children, children fork plan) -> review -> finish,
/// where the wait -> review edge resumes plan's conversation, and a parent
/// task assigned to it.
#[given(
    expr = "a parent workflow on the {string} harness whose children fork its plan conversation"
)]
pub async fn given_forking_parent_workflow(world: &mut DaemonWorld, harness: String) {
    create_session_workflow(world).await;
    world
        .fixture_ids
        .insert("harness".to_string(), harness.clone());
    let workflow_id = world.workflow_id.clone().expect("workflow created");
    world.parent_workflow_id = Some(workflow_id.clone());
    let plan = llm_step(world, "plan", &harness, "0").await;
    let fork = format!("fork:{plan}");
    let wait = add_step(
        world,
        "wait",
        &[
            "--step-type",
            "wait_children",
            "--order",
            "1",
            "--harness",
            "claude",
            "--children-session",
            &fork,
        ],
    )
    .await;
    let review = llm_step(world, "review", &harness, "2").await;
    let finish = typed_step(world, &workflow_id, "finish", "finish", "3").await;
    link(world, &plan, &wait, None).await;
    link(world, &wait, &review, Some(format!("resume:{plan}"))).await;
    link(world, &review, &finish, None).await;

    for (role, id) in [("plan", plan.clone()), ("review", review)] {
        world.fixture_ids.insert(role.to_string(), id);
        let response = answer(world, role, "done");
        set_prompt(world, role, response).await;
    }

    let parent = create_task(world, "daemon-acc-forking-parent", None).await;
    world
        .run_vtb(&["workflow", "assign", &parent, &workflow_id])
        .await;
    world.assert_vtb_ok("workflow assign (parent)");
    world.task_id = Some(parent.clone());
    world.parent_task_id = Some(parent);
    world.step_id = Some(plan);
}

/// Child tasks of the parent, assigned to a new workflow whose entry step is
/// `entry` (named `child` or `gate`) on the parent's harness.
#[given(expr = "{int} child tasks assigned to a workflow whose entry step is {word}")]
pub async fn given_children_with_entry(world: &mut DaemonWorld, count: usize, entry: String) {
    let harness = fixture(world, "harness");
    let child_workflow = new_workflow(world, "fork-child").await;
    let role = if entry == "llm_inference" {
        "child"
    } else {
        "gate"
    };
    entry_step(world, &child_workflow, &entry, &harness, role).await;
    world.child_workflow_id = Some(child_workflow.clone());
    let parent = world.parent_task_id.clone().expect("parent task created");
    for index in 0..count {
        let child = create_task(
            world,
            &format!("daemon-acc-fork-child-{index}"),
            Some(&parent),
        )
        .await;
        world
            .run_vtb(&["workflow", "assign", &child, &child_workflow])
            .await;
        world.assert_vtb_ok("workflow assign (child)");
        world.child_task_ids.push(child);
    }
}

// ===== When =====

#[when(expr = "I wait for every child TaskRun to fail at dispatch naming the {word} step")]
pub async fn wait_for_children_dispatch_failure(world: &mut DaemonWorld, role: String) {
    let step = fixture(world, &role);
    let deadline = Instant::now() + RUN_TIMEOUT;
    loop {
        let mut pending = Vec::new();
        for child in world.child_task_ids.clone() {
            let runs = list_task_runs(world, &child).await;
            if !runs.iter().any(|run| {
                run.status.eq_ignore_ascii_case("failed")
                    && run.outcome_kind.as_deref() == Some("dispatch_failed")
                    && run.outcome_context.as_ref().map(|c| &c["reason"]) == Some(&json!(step))
            }) {
                pending.push((child, runs));
            }
        }
        if pending.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for child runs to fail naming {role} step {step}: {pending:?}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ===== Then =====

#[then("the followup execution resumed the work conversation in the same TaskRun")]
pub async fn followup_resumed_work(world: &mut DaemonWorld) {
    let task = task_id(world);
    let work = turn(world, &task, "work").await;
    let followup = turn(world, &task, "followup").await;
    let conversation = native(&work);
    assert_eq!(native(&followup), conversation, "{followup:?}");
    assert_eq!(followup.resume.as_deref(), Some(conversation.as_str()));
    assert_eq!(work.root.as_deref(), Some(work.id.as_str()), "{work:?}");
    assert_eq!(followup.root.as_deref(), Some(work.id.as_str()));
    assert_eq!(followup.forked_from, None);
    assert_eq!(followup.task_run_id, work.task_run_id);
    assert_eq!(list_task_runs(world, &task).await.len(), 1);
    assert_resumed(world, &conversation, 2);
}

#[then("the revise execution resumed the draft conversation of the stopped run")]
pub async fn revise_resumed_stopped_run(world: &mut DaemonWorld) {
    let task = task_id(world);
    let draft = turn(world, &task, "draft").await;
    let revise = turn(world, &task, "revise").await;
    let conversation = native(&draft);
    assert_eq!(native(&revise), conversation, "{revise:?}");
    assert_eq!(revise.resume.as_deref(), Some(conversation.as_str()));
    assert_eq!(revise.root.as_deref(), Some(draft.id.as_str()));
    assert_eq!(revise.forked_from, None);
    assert_ne!(
        revise.task_run_id, draft.task_run_id,
        "{draft:?} {revise:?}"
    );
    let runs = list_task_runs(world, &task).await;
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert!(
        runs.iter()
            .any(|run| Some(&run.id) == draft.task_run_id.as_ref()
                && run.outcome_kind.as_deref() == Some("run_boundary")),
        "draft ran in the run that stopped at the boundary: {runs:?}"
    );
    assert_resumed(world, &conversation, 2);
}

/// The provider continued `conversation` in the `launches`-th launch: Claude
/// with `--resume` and no fork, Codex with `thread/resume`.
fn assert_resumed(world: &DaemonWorld, conversation: &str, launches: usize) {
    if is_codex(world) {
        assert_eq!(codex_requests(world, "thread/start").len(), 1);
        let resumes = codex_requests(world, "thread/resume");
        assert_eq!(resumes.len(), 1, "{resumes:?}");
        assert_eq!(resumes[0]["params"]["threadId"], json!(conversation));
        assert!(codex_requests(world, "thread/fork").is_empty());
        let turns = codex_requests(world, "turn/start");
        assert_eq!(turns.len(), launches, "{turns:?}");
        assert_eq!(
            turns[launches - 1]["params"]["threadId"],
            json!(conversation)
        );
    } else {
        let all = claude_launches(world);
        assert_eq!(all.len(), launches, "{all:?}");
        let last = &all[launches - 1];
        assert_eq!(flag_value(last, "--resume").as_deref(), Some(conversation));
        assert_eq!(flag_value(last, "--session-id"), None, "{last:?}");
        assert!(!last.iter().any(|arg| arg == "--fork-session"), "{last:?}");
    }
}

#[then(expr = "the TaskRun failed at dispatch naming the {word} step and the provider ran once")]
pub async fn task_run_failed_naming(world: &mut DaemonWorld, role: String) {
    let task = task_id(world);
    let step = fixture(world, &role);
    let runs = list_task_runs(world, &task).await;
    assert!(
        runs.iter().any(|run| {
            run.status.eq_ignore_ascii_case("failed")
                && run.outcome_kind.as_deref() == Some("dispatch_failed")
                && run.outcome_context.as_ref().map(|c| &c["reason"]) == Some(&json!(step))
        }),
        "expected a dispatch_failed TaskRun naming {role} step {step}: {runs:?}"
    );
    assert!(
        turns(world, &task)
            .await
            .iter()
            .all(|turn| turn.step_name != role || turn.native.is_none()),
        "the {role} step must not run a provider turn"
    );
    if is_codex(world) {
        assert_eq!(codex_requests(world, "turn/start").len(), 1);
    } else {
        assert_eq!(claude_launches(world).len(), 1);
    }
}

#[then("each child forked the parent's plan conversation")]
pub async fn children_forked_plan(world: &mut DaemonWorld) {
    let parent = world.parent_task_id.clone().expect("parent task created");
    let plan = turn(world, &parent, "plan").await;
    let conversation = native(&plan);
    let mut child_conversations = BTreeSet::new();
    for child_task in world.child_task_ids.clone() {
        let child = turn(world, &child_task, "child").await;
        let child_conversation = native(&child);
        assert_ne!(child_conversation, conversation, "{child:?}");
        assert_eq!(child.resume.as_deref(), Some(conversation.as_str()));
        assert_eq!(child.forked_from.as_deref(), Some(plan.id.as_str()));
        assert_eq!(child.root.as_deref(), Some(child.id.as_str()), "{child:?}");
        assert_ne!(child.task_run_id, plan.task_run_id);
        child_conversations.insert(child_conversation);
    }
    assert_eq!(child_conversations.len(), world.child_task_ids.len());

    if is_codex(world) {
        let forks = codex_requests(world, "thread/fork");
        assert_eq!(forks.len(), world.child_task_ids.len(), "{forks:?}");
        assert!(
            forks
                .iter()
                .all(|fork| fork["params"]["threadId"] == json!(conversation)),
            "{forks:?}"
        );
    } else {
        let forks: Vec<_> = claude_launches(world)
            .into_iter()
            .filter(|argv| argv.iter().any(|arg| arg == "--fork-session"))
            .collect();
        assert_eq!(forks.len(), world.child_task_ids.len(), "{forks:?}");
        for argv in &forks {
            assert_eq!(
                flag_value(argv, "--resume").as_deref(),
                Some(conversation.as_str())
            );
            let forked = flag_value(argv, "--session-id").expect("fork names its new session");
            assert!(child_conversations.contains(&forked), "{argv:?}");
        }
    }
}

#[then("the parent's review resumed its plan conversation unchanged")]
pub async fn review_resumed_plan(world: &mut DaemonWorld) {
    let parent = world.parent_task_id.clone().expect("parent task created");
    let plan = turn(world, &parent, "plan").await;
    let review = turn(world, &parent, "review").await;
    let conversation = native(&plan);
    assert_eq!(native(&review), conversation, "{review:?}");
    assert_eq!(review.resume.as_deref(), Some(conversation.as_str()));
    assert_eq!(review.root.as_deref(), Some(plan.id.as_str()));
    assert_eq!(review.forked_from, None);
    assert_eq!(review.task_run_id, plan.task_run_id);
    if is_codex(world) {
        let resumes = codex_requests(world, "thread/resume");
        assert_eq!(resumes.len(), 1, "{resumes:?}");
        assert_eq!(resumes[0]["params"]["threadId"], json!(conversation));
    } else {
        let resumes: Vec<_> = claude_launches(world)
            .into_iter()
            .filter(|argv| {
                flag_value(argv, "--resume").as_deref() == Some(conversation.as_str())
                    && !argv.iter().any(|arg| arg == "--fork-session")
            })
            .collect();
        assert_eq!(resumes.len(), 1, "{resumes:?}");
    }
}

#[then("no child ran a provider turn")]
pub async fn no_child_provider_turn(world: &mut DaemonWorld) {
    if is_codex(world) {
        assert!(codex_requests(world, "thread/fork").is_empty());
        assert_eq!(codex_requests(world, "turn/start").len(), 1);
    } else {
        let launches = claude_launches(world);
        assert_eq!(
            launches.len(),
            1,
            "only the parent's plan ran: {launches:?}"
        );
    }
}
