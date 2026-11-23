use super::*;
use vertebrae_harness_core::{PermissionMode, SpeedTier, TurnSettings};

#[derive(Debug)]
struct Step {
    second_model: bool,
    fast: bool,
    plan: bool,
    update: bool,
    idle_update: bool,
    blocked: bool,
    replies: Vec<(u8, &'static str)>,
}

#[test]
fn generated_configuration_and_steering_match_the_rpc_oracle() {
    Hegel::new(|tc: TestCase| {
        let mut trace = Vec::new();
        for _ in 0..tc.draw(gs::integers::<usize>().min_value(1).max_value(5)) {
            let replies = (0..tc.draw(gs::integers::<usize>().min_value(1).max_value(5)))
                .map(|_| {
                    (
                        tc.draw(gs::integers::<u8>()),
                        if tc.draw(gs::booleans()) {
                            "cancelled"
                        } else {
                            "end_turn"
                        },
                    )
                })
                .collect();
            trace.push(Step {
                second_model: tc.draw(gs::booleans()),
                fast: tc.draw(gs::booleans()),
                plan: tc.draw(gs::booleans()),
                update: tc.draw(gs::booleans()),
                idle_update: tc.draw(gs::booleans()),
                blocked: tc.draw(gs::integers::<u8>().max_value(3)) == 0,
                replies,
            });
        }
        let partial = tc.draw(gs::booleans());
        tc.note(&format!("{trace:?}; partial failure: {partial}"));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                timeout(Duration::from_secs(15), check(trace, partial))
                    .await
                    .unwrap()
            });
    })
    .settings(Settings::new().test_cases(40))
    .run();
}

async fn check(trace: Vec<Step>, partial: bool) {
    let fixture = format!(
        "{}/tests/fixtures/configurable_agent.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let adapter = AcpRuntime::new(
        "/usr/bin/env".into(),
        vec!["python3".into(), fixture],
        Default::default(),
    );
    let cwd = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let controls = Arc::new(ModelControls::default());
    let session = start(
        &adapter,
        cwd.path().into(),
        events.clone(),
        controls.clone(),
    )
    .await
    .unwrap();
    let mut last_second_model = false;
    let mut expected_outcomes = Vec::new();
    for (index, step) in trace.iter().enumerate() {
        let (model, effort) = if step.second_model {
            ("second-model", "medium")
        } else {
            ("default-model", "high")
        };
        last_second_model = step.second_model;
        let fast = step.fast && step.second_model;
        let mut order: Vec<_> = (0..step.replies.len()).collect();
        order.sort_by_key(|index| step.replies[*index].0);
        let stops: Vec<_> = step.replies.iter().map(|(_, stop)| *stop).collect();
        let marker = format!("ready-{index}");
        let payload = json!({
            "expected": {
                "model":model, "thinking":effort,
                "speed_tier":if fast { "fast" } else { "default" },
                "mode":if step.plan { "plan" } else { "default" },
            },
            "update":step.update, "idle_update":step.idle_update,
            "marker":marker, "stops":stops, "order":order, "blocked":step.blocked,
        });
        let mut request = turn(&format!("turn-{index}"), &payload.to_string());
        request.settings = TurnSettings {
            model: Some(model.into()),
            reasoning_effort: Some(effort.into()),
            speed_tier: Some(if fast {
                SpeedTier::Fast
            } else {
                SpeedTier::Default
            }),
            permission_mode: Some(if step.plan {
                PermissionMode::Plan
            } else {
                PermissionMode::Default
            }),
        };
        let active = session.send(request).await.unwrap();
        loop {
            {
                let emitted = events.0.lock().await;
                if emitted
                    .iter()
                    .any(|event| matches!(&event.payload, Event::Text(text) if text.text == marker))
                {
                    break;
                }
                assert!(
                    !emitted
                        .iter()
                        .any(
                            |event| event.correlation.turn_id.as_ref() == Some(active.turn_id())
                                && matches!(&event.payload, Event::TurnFinished(_))
                        ),
                    "turn ended before wire checkpoint: {:?}",
                    std::fs::read_to_string(cwd.path().join("oracle-failure"))
                );
            }
            events.1.notified().await;
        }
        if step.blocked {
            controls.pending.notified().await;
            assert!(
                session
                    .steer(active.turn_id(), "must not dispatch".into())
                    .await
                    .is_err()
            );
            active.interrupt().await.unwrap();
            assert_eq!(
                active.await_outcome().await.unwrap().status,
                CompletionStatus::Interrupted
            );
            expected_outcomes.push(CompletionStatus::Interrupted);
            continue;
        }
        for index in 0..stops.len() - 1 {
            assert_eq!(
                session
                    .steer(active.turn_id(), format!("steer {index}"))
                    .await
                    .unwrap(),
                *active.turn_id()
            );
        }
        let status = if stops.last() == Some(&"cancelled") {
            CompletionStatus::Interrupted
        } else {
            CompletionStatus::Completed
        };
        assert_eq!(active.await_outcome().await.unwrap().status, status);
        expected_outcomes.push(status);
        if step.idle_update {
            // The fixture writes its marker after the client handles the subsequent idle RPC.
            // That handshake establishes that the earlier configuration notification was read.
            let barrier = cwd.path().join(&marker);
            while !barrier.is_file() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }
    }

    let mut invalid = turn("rejected", "a rejected turn must never reach the agent");
    if partial {
        invalid.settings.model = Some(
            if last_second_model {
                "default-model"
            } else {
                "second-model"
            }
            .into(),
        );
    }
    invalid.settings.reasoning_effort = Some("not-advertised".into());
    let active = session.send(invalid).await.unwrap();
    assert_eq!(
        active.await_outcome().await.unwrap().status,
        CompletionStatus::Failed
    );
    expected_outcomes.push(CompletionStatus::Failed);
    if partial {
        session.termination().unwrap().await;
    } else {
        assert_eq!(
            session
                .send(turn("retry", "after rejection"))
                .await
                .unwrap()
                .await_outcome()
                .await
                .unwrap()
                .status,
            CompletionStatus::Completed
        );
        expected_outcomes.push(CompletionStatus::Completed);
        session.close().await.unwrap();
    }

    let events = events.0.lock().await;
    let starts: Vec<_> = events
        .iter()
        .filter(|e| matches!(e.payload, Event::TurnStarted(_)))
        .map(|e| e.correlation.turn_id.clone())
        .collect();
    let finishes: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.payload {
            Event::TurnFinished(outcome) => Some((e.correlation.turn_id.clone(), outcome.status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        finishes
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        expected_outcomes,
        finishes
            .iter()
            .map(|(_, status)| *status)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, Event::Error(_)))
            .count(),
        usize::from(partial)
    );
    assert!(events.iter().any(|e| matches!(&e.payload, Event::SessionClosed(value) if value.status == if partial { SessionCloseStatus::ProcessLost } else { SessionCloseStatus::Closed })));
}
