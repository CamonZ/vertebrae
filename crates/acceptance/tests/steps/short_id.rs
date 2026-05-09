//! Step definitions for short ID resolution acceptance tests.
//!
//! Provides helpers for storing the 8-character short ID prefixes of tasks,
//! workflows, and steps, plus a generic `I run vtb` step that splits a
//! whitespace-separated argument string and invokes the binary. The argument
//! string is run through `resolve_vars`, so `<key>` placeholders are
//! substituted from `stored_ids` (and `<TASK_ID>` from the current task) prior
//! to splitting.

use cucumber::{given, when};
use regex::Regex;

use crate::SmokeWorld;

fn short(id: &str) -> String {
    id.chars().take(8).collect()
}

#[given(expr = "I store the task short ID as {string}")]
#[when(expr = "I store the task short ID as {string}")]
async fn store_task_short_id(world: &mut SmokeWorld, name: String) {
    let task_id = world
        .task_id
        .as_ref()
        .expect("no task ID to store as short")
        .clone();
    world.stored_ids.insert(name, short(&task_id));
}

#[given(expr = "I store the workflow short ID as {string}")]
#[when(expr = "I store the workflow short ID as {string}")]
async fn store_workflow_short_id(world: &mut SmokeWorld, name: String) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID to store as short")
        .clone();
    world.stored_ids.insert(name, short(&wf_id));
}

/// Capture the short ID of a previously stored step (under key `step:<step_name>`)
/// and store it under `name` so it can be referenced as `<name>` in scenarios.
#[given(expr = "I store the short ID of step {string} as {string}")]
#[when(expr = "I store the short ID of step {string} as {string}")]
async fn store_step_short_id(world: &mut SmokeWorld, step_name: String, name: String) {
    let key = format!("step:{}", step_name);
    let full = world
        .stored_ids
        .get(&key)
        .unwrap_or_else(|| {
            panic!(
                "no stored ID for step '{}' (expected key '{}')",
                step_name, key
            )
        })
        .clone();
    world.stored_ids.insert(name, short(&full));
}

#[given(expr = "I store the latest TaskRun ID as {string}")]
#[when(expr = "I store the latest TaskRun ID as {string}")]
async fn store_latest_task_run_id(world: &mut SmokeWorld, name: String) {
    let re = Regex::new(r"taskRun=([0-9a-f-]{36})").expect("valid TaskRun ID regex");
    let output = world.combined_output();
    let captures = re
        .captures(&output)
        .unwrap_or_else(|| panic!("no taskRun=<uuid> found in output:\n{}", output));
    world.stored_ids.insert(name, captures[1].to_string());
}

#[given(expr = "I store the latest TaskRun short ID as {string}")]
#[when(expr = "I store the latest TaskRun short ID as {string}")]
async fn store_latest_task_run_short_id(world: &mut SmokeWorld, name: String) {
    let re = Regex::new(r"taskRun=([0-9a-f-]{36})").expect("valid TaskRun ID regex");
    let output = world.combined_output();
    let captures = re
        .captures(&output)
        .unwrap_or_else(|| panic!("no taskRun=<uuid> found in output:\n{}", output));
    world.stored_ids.insert(name, short(&captures[1]));
}

#[given(expr = "I store the TaskRun ID for task {string} as {string}")]
#[when(expr = "I store the TaskRun ID for task {string} as {string}")]
async fn store_task_run_id_for_task(world: &mut SmokeWorld, task_ref: String, name: String) {
    let task_id = world.resolve_vars(&task_ref);
    let pattern = format!(r"run ([0-9a-f-]{{36}}) task={}", regex::escape(&task_id));
    let re = Regex::new(&pattern).expect("valid task TaskRun ID regex");
    let output = world.combined_output();
    let captures = re.captures(&output).unwrap_or_else(|| {
        panic!(
            "no TaskRun ID found for task {} in output:\n{}",
            task_id, output
        )
    });
    world.stored_ids.insert(name, captures[1].to_string());
}

/// Generic vtb invocation. Splits `args_str` on whitespace after substituting
/// `<KEY>` placeholders. Quoted arguments are not supported — keep arg values
/// short and placeholder-driven (which is what the short-ID scenarios need).
#[given(expr = "I run vtb {string}")]
#[when(expr = "I run vtb {string}")]
async fn when_run_vtb(world: &mut SmokeWorld, args_str: String) {
    let resolved = world.resolve_vars(&args_str);
    let parts: Vec<&str> = resolved.split_whitespace().collect();
    world.run_vtb(&parts).await;
}
