//! Independent workflow lifecycle oracle over generated agent updates and exits.

use std::{sync::Arc, time::Duration};

use hegel::{Hegel, Settings, TestCase, generators as gs};
use serde_json::json;
use vertebrae_harness_core::{
    CompletionStatus, HarnessEventPayloadV1 as Event, HarnessRuntime, RequestConfig, RunRequest,
};

use super::super::{AcpRuntime, Events, NoWorkflowControls};

#[test]
fn generated_workflow_traces_match_the_one_shot_lifecycle_model() {
    Hegel::new(|tc: TestCase| {
        let count = tc.draw(gs::integers::<usize>().max_value(8));
        let actions: Vec<_> = (0..count)
            .map(|_| ["text", "usage", "permission"][tc.draw(gs::integers::<usize>().max_value(2))])
            .collect();
        let ending = ["complete", "error", "eof", "cancel", "agent-cancel"]
            [tc.draw(gs::integers::<usize>().max_value(4))];
        let cancel_calls = tc.draw(gs::integers::<usize>().min_value(1).max_value(4));
        tc.note(&format!(
            "actions={actions:?}, ending={ending}, cancel_calls={cancel_calls}"
        ));

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(8),
                    check_run(&actions, ending, cancel_calls),
                )
                .await
                .expect("ACP workflow trace timed out");
            });
    })
    .settings(Settings::new().test_cases(40))
    .run();
}

async fn check_run(actions: &[&str], ending: &str, cancel_calls: usize) {
    let fixture = format!("{}/tests/fixtures/agent.py", env!("CARGO_MANIFEST_DIR"));
    let agent = AcpRuntime::new(
        "/usr/bin/env".into(),
        vec!["python3".into(), fixture, "--workflow-model".into()],
        Default::default(),
    );
    let workspace = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let run = agent
        .run_once(
            RunRequest {
                run_id: "generated-run".into(),
                stream_id: "generated-stream".into(),
                prompt: json!([actions, ending]).to_string(),
                config: RequestConfig {
                    working_directory: Some(workspace.path().into()),
                    ..Default::default()
                },
            },
            events.clone(),
            Arc::new(NoWorkflowControls),
        )
        .await
        .unwrap();

    if ending == "cancel" {
        loop {
            let changed = events.1.notified();
            if events.0.lock().await.iter().any(|event| {
                matches!(&event.payload, Event::Text(text) if text.text == "cancel checkpoint")
            }) {
                break;
            }
            changed.await;
        }
        for _ in 0..cancel_calls {
            run.cancel().await.unwrap();
        }
    }

    let outcome = run.await_outcome().await.unwrap();
    assert_eq!(run.await_outcome().await.unwrap(), outcome);
    let expected_status = match ending {
        "complete" => CompletionStatus::Completed,
        "cancel" | "agent-cancel" => CompletionStatus::Cancelled,
        _ => CompletionStatus::Failed,
    };
    assert_eq!(outcome.status, expected_status);
    if ending == "complete" {
        let expected: String = actions
            .iter()
            .enumerate()
            .filter(|(_, action)| **action == "text")
            .map(|(index, _)| format!("{index} "))
            .collect();
        assert_eq!(outcome.result_text.as_deref(), Some(expected.as_str()));
        assert!(workspace.path().join("workflow-model-closed").is_file());
    } else {
        assert_eq!(outcome.result_text, None);
        assert!(!workspace.path().join("workflow-model-closed").exists());
    }
    if let Some(expected) = match ending {
        "error" => Some("code -32603"),
        "eof" => Some("41"),
        _ => None,
    } {
        let error = outcome.error.as_deref().unwrap();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("private fixture detail"), "{error}");
    }

    let mut expected_events = vec!["input"];
    expected_events.extend(
        actions
            .iter()
            .copied()
            .filter(|action| *action != "permission"),
    );
    if ending == "cancel" {
        expected_events.push("text");
    }
    expected_events.push("finished");
    let delivered = events.0.lock().await;
    assert_eq!(delivered.len(), expected_events.len());
    for (index, (event, expected)) in delivered.iter().zip(expected_events).enumerate() {
        assert_eq!(event.sequence, index as u64 + 1);
        assert_eq!(event.correlation.run_id.as_ref(), Some(run.run_id()));
        match (&event.payload, expected) {
            (Event::TurnInput(_), "input")
            | (Event::Text(_), "text")
            | (Event::Usage(_), "usage") => {}
            (Event::RunFinished(result), "finished") => assert_eq!(result, &outcome),
            (unexpected, _) => panic!("expected {expected}, got {unexpected:?}"),
        }
    }
}
