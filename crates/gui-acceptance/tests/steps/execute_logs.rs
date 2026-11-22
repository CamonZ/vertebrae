//! Execute traces verified through the daemon, Sacrum and the GUI.

use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use fantoccini::Locator;
use serde_json::{Value, json};

use crate::GuiWorld;

#[given(expr = "I create the {string} execute logging fixture")]
async fn create_execute_log_step(world: &mut GuiWorld, fixture: String) {
    let workflow_id = world.workflow_id.clone().expect("workflow");
    let (script, schema) = match fixture.as_str() {
        "stdout" => (
            r#"
                vtb::log::info("execute-info");
                vtb::cmd::run("sh", ["-c",
                    "for i in $(seq 60); do test -f execute-print && break; sleep 1; done; test -f execute-print || exit 98; printf execute-; printf 'stdout\n'; for i in $(seq 60); do if test -f execute-release; then printf final-line; printf stderr >&2; exit 3; fi; sleep 1; done; exit 99"
                ], #{})
            "#,
            r#"{"type":"object","required":["exit_code","stdout","stderr"],"properties":{"exit_code":{"const":3},"stdout":{"const":"execute-stdout\nfinal-line"},"stderr":{"const":"stderr"}}}"#,
        ),
        "duplicate" => (
            r#"
                let released = false;
                for attempt in 0..5000 {
                    if vtb::artifacts::read(task.id, "execute-release") == "go" {
                        released = true;
                        break;
                    }
                }
                if !released { throw "fixture was not released"; }
                vtb::log::info("same-rhai-message");
                vtb::log::info("same-rhai-message");
                true
            "#,
            r#"{"const":true}"#,
        ),
        _ => panic!("unknown execute fixture {fixture}"),
    };
    world
        .run_vtb(&[
            "step",
            "add",
            "Execute Logs",
            "--workflow",
            &workflow_id,
            "--step-type",
            "execute",
            "--script",
            script,
            "--output-schema",
            schema,
        ])
        .await;
    assert_eq!(world.last_exit_code, 0, "{}", world.last_stderr);
    let step_id = world
        .extract_step_id_from_output()
        .expect("execute step ID");
    world.track_step(step_id.clone());
    world.step_id = Some(step_id);
}

#[when(expr = "I signal the execute command to {string}")]
async fn signal_execute_command(world: &mut GuiWorld, signal: String) {
    let dir = world.temp_dir.as_ref().expect("project path");
    assert!(matches!(signal.as_str(), "print" | "release"));
    std::fs::write(dir.join(format!("execute-{signal}")), "").expect("signal the command");
}

#[when("I release the script log fixture")]
async fn release_script_log_fixture(world: &mut GuiWorld) {
    let task = world.task_id.clone().expect("task ID");
    world
        .run_vtb(&[
            "artifact",
            "add",
            "execute-release.txt",
            "--body",
            "go",
            "--subject-type",
            "task",
            "--subject-id",
            &task,
            "--logical-name",
            "execute-release",
        ])
        .await;
    assert_eq!(world.last_exit_code, 0, "{}", world.last_stderr);
}

#[then(expr = "the running execute attempt has durable logs {string}")]
async fn running_execute_logs(world: &mut GuiWorld, expected: String) {
    let (execution, logs) = execute_logs(world, expected.split(',').count()).await;
    assert_eq!(execution["status"], "in_progress");
    assert_execute_logs(&execution, &logs, &expected);
    let wd = world.webdriver.as_ref().expect("WebDriver").clone();
    let client = wd.lock().await;
    world.screenshot(&client, "execute-live-stdout").await;
}

async fn execute_logs(world: &GuiWorld, expected_count: usize) -> (Value, Value) {
    let task_id = world.task_id.as_ref().expect("task ID");
    let client = world.graphql_client.as_ref().expect("GraphQL client");
    use vertebrae_sacrum_client::{client::with_fragments, queries::executions};
    let executions: Vec<Value> = client
        .execute(
            &with_fragments(executions::LIST_EXECUTIONS, &[executions::EXECUTION_FIELDS]),
            json!({"task_id": task_id}),
            "step_executions",
        )
        .await
        .expect("list execute attempts");
    let mut attempts = executions
        .into_iter()
        .filter(|execution| execution["step_type"] == "execute");
    let execution = attempts.next().expect("execute attempt");
    assert!(attempts.next().is_none(), "expected one execute attempt");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let logs: Vec<Value> = client
            .execute(
                executions::LIST_LOGS,
                json!({ "step_execution_id": execution["id"] }),
                "session_logs",
            )
            .await
            .expect("list execute session logs");
        if logs.len() >= expected_count || Instant::now() >= deadline {
            return (execution, Value::Array(logs));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn assert_execute_logs(execution: &Value, logs: &Value, expected: &str) {
    let mut records: Vec<(u64, Value)> = logs
        .as_array()
        .expect("session logs")
        .iter()
        .filter_map(|log| {
            let content: Value = serde_json::from_str(log["content"].as_str()?).ok()?;
            if content["type"] != "text" {
                return None;
            }
            assert_eq!(log["step_execution_id"], execution["id"]);
            Some((content["sequence"].as_u64().expect("sequence"), content))
        })
        .collect();
    records.sort_by_key(|(sequence, _)| *sequence);
    let texts: Vec<_> = records
        .iter()
        .map(|(_, event)| event["data"]["text"].as_str().expect("text"))
        .collect();
    assert_eq!(texts, expected.split(',').collect::<Vec<_>>());
    let identities: std::collections::HashSet<_> = records
        .iter()
        .map(|(_, event)| event["event_id"].as_str().expect("event ID"))
        .collect();
    assert_eq!(identities.len(), texts.len());
}

#[then(expr = "the execute trace shows these messages in order {string}")]
async fn execute_trace_messages(world: &mut GuiWorld, expected: String) {
    let wd = world.webdriver.as_ref().expect("WebDriver").clone();
    let client = wd.lock().await;
    let deadline = Instant::now() + Duration::from_secs(20);
    let expected_texts: Vec<_> = expected.split(',').collect();
    loop {
        let mut texts = Vec::new();
        for element in client
            .find_all(Locator::Css(
                "[data-testid='run-pane-scroll'] .evrow--agent .evprose",
            ))
            .await
            .unwrap_or_default()
        {
            if let Ok(Some(text)) = element.prop("textContent").await {
                texts.push(text.trim().to_owned());
            }
        }
        if texts == expected_texts {
            world.screenshot(&client, "execute-trace-logs").await;
            break;
        }
        assert!(
            Instant::now() < deadline,
            "expected {expected_texts:?}, saw {texts:?}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let (execution, logs) = execute_logs(world, expected.split(',').count()).await;
    assert_execute_logs(&execution, &logs, &expected);
}
