use cucumber::then;
use vertebrae_sacrum_client::StepExecutionResponse;

use crate::DaemonWorld;

fn last_execution(world: &DaemonWorld) -> &StepExecutionResponse {
    world
        .last_execution
        .as_ref()
        .expect("no execution polled yet — call `wait for the execution to reach status` first")
}

#[then(expr = "the execution status is {string}")]
pub async fn status_is(world: &mut DaemonWorld, expected: String) {
    let exec = last_execution(world);
    assert_eq!(
        exec.status.to_ascii_lowercase(),
        expected.to_ascii_lowercase(),
        "expected status={expected}, got {exec:?}",
    );
}

#[then(expr = "the execution output contains {string}")]
pub async fn output_contains(world: &mut DaemonWorld, needle: String) {
    let exec = last_execution(world);
    let output = exec.output.as_deref().unwrap_or("");
    assert!(
        output.contains(&needle),
        "expected output to contain {needle:?}, got {output:?}",
    );
}

#[then(expr = "the execution records input_tokens {int} and output_tokens {int}")]
pub async fn records_tokens(world: &mut DaemonWorld, input: i64, output: i64) {
    let exec = last_execution(world);
    assert_eq!(
        exec.effective_input_tokens(),
        Some(input),
        "unexpected input_tokens"
    );
    assert_eq!(
        exec.effective_output_tokens(),
        Some(output),
        "unexpected output_tokens"
    );
}

#[then("the execution records positive duration_ms")]
pub async fn records_positive_duration(world: &mut DaemonWorld) {
    let exec = last_execution(world);
    let duration = exec.duration_ms.unwrap_or(0);
    assert!(duration > 0, "expected duration_ms > 0, got {duration}");
}

#[then(expr = "the execution records a non-zero cost")]
pub async fn records_cost(world: &mut DaemonWorld) {
    let exec = last_execution(world);
    let cost = exec.cost.unwrap_or(0.0);
    assert!(cost > 0.0, "expected cost > 0, got {cost:?}");
}

#[then("the execution has no recorded output")]
pub async fn no_recorded_output(world: &mut DaemonWorld) {
    let exec = last_execution(world);
    let output = exec.output.as_deref().unwrap_or("");
    assert!(output.is_empty(), "expected no output, got {output:?}",);
}

#[then("the execution has no recorded metrics")]
pub async fn no_recorded_metrics(world: &mut DaemonWorld) {
    let exec = last_execution(world);
    assert!(
        exec.input_tokens.is_none(),
        "unexpected input_tokens: {:?}",
        exec.input_tokens
    );
    assert!(
        exec.output_tokens.is_none(),
        "unexpected output_tokens: {:?}",
        exec.output_tokens
    );
    assert!(exec.cost.is_none(), "unexpected cost: {:?}", exec.cost);
    assert!(
        exec.duration_ms.is_none(),
        "unexpected duration_ms: {:?}",
        exec.duration_ms
    );
}

#[then(expr = "the mock argv contains {string} followed by {string}")]
pub async fn argv_contains_pair(world: &mut DaemonWorld, first: String, second: String) {
    let argv = world.captured_argv();
    let idx = argv
        .iter()
        .position(|a| a == &first)
        .unwrap_or_else(|| panic!("{first:?} not in argv: {argv:?}"));
    let next = argv
        .get(idx + 1)
        .unwrap_or_else(|| panic!("{first:?} has no following arg in argv: {argv:?}"));
    assert_eq!(
        next, &second,
        "expected {second:?} after {first:?}, got {next:?} in {argv:?}"
    );
}

#[then("the mock argv contains the managed manifestless skill plugin root exactly once")]
pub async fn argv_contains_managed_plugin_root_once(world: &mut DaemonWorld) {
    let argv = world.captured_argv();
    let managed_root = world
        .managed_plugin_root
        .as_ref()
        .expect("configured daemon environment should record managed plugin root");
    let managed_root = managed_root.to_string_lossy();
    let matches = argv
        .windows(2)
        .filter(|pair| pair[0] == "--plugin-dir" && pair[1] == managed_root)
        .count();
    assert_eq!(
        matches, 1,
        "managed plugin root should appear once: {argv:?}"
    );
    assert!(
        std::path::Path::new(managed_root.as_ref())
            .join("skills/acceptance-proof/SKILL.md")
            .is_file(),
        "manifestless installed skill should exist below managed plugin root"
    );
}

#[then(expr = "the mock argv contains {string} exactly {int} time(s)")]
pub async fn argv_contains_n(world: &mut DaemonWorld, needle: String, expected: usize) {
    let argv = world.captured_argv();
    let actual = argv.iter().filter(|a| *a == &needle).count();
    assert_eq!(
        actual, expected,
        "expected {needle:?} to appear {expected} time(s), saw {actual} in {argv:?}"
    );
}

#[then(expr = "the mock working directory is {string}")]
pub async fn mock_cwd_is(world: &mut DaemonWorld, expected: String) {
    let cwd = world.captured_cwd();
    assert_eq!(cwd.trim(), expected, "expected cwd={expected}, got {cwd:?}");
}

#[then(expr = "the execution has {int} session log entries")]
pub async fn session_log_count(world: &mut DaemonWorld, expected: usize) {
    let execution_id = world
        .execution_id
        .as_ref()
        .expect("no execution id recorded")
        .clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let resp: serde_json::Value = client
        .execute(
            vertebrae_sacrum_client::queries::executions::LIST_LOGS,
            serde_json::json!({ "step_execution_id": execution_id }),
            "session_logs",
        )
        .await
        .expect("session_logs query failed");
    let arr = resp
        .as_array()
        .unwrap_or_else(|| panic!("session_logs is not an array: {resp}"));
    assert_eq!(
        arr.len(),
        expected,
        "expected {expected} session_logs, got {}: {resp}",
        arr.len()
    );
    for entry in arr {
        assert_eq!(
            entry["step_execution_id"].as_str(),
            Some(execution_id.as_str()),
            "session log has wrong step_execution_id: {entry}"
        );
    }
}
