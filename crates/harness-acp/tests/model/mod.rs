//! The Python subprocess checks replies against the options it sent.
//! The model here checks the independent consumer-facing lifecycle.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use hegel::{Hegel, Settings, TestCase, generators as gs};
use serde_json::json;
use tokio::{sync::Notify, time::timeout};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequest, ControlRequestEnvelope, ControlResolution,
    ControlSink, HarnessError, HarnessEventPayloadV1 as Event, QuestionAnswer, ResolutionSource,
    SessionCloseStatus,
};

use super::{AcpRuntime, Events, start, turn};

#[derive(Clone, Copy, Debug)]
enum Operation {
    Select,
    Unknown,
    Duplicate,
    Interrupt,
}

impl Operation {
    fn wire_scenario(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Unknown => "unknown",
            Self::Duplicate => "duplicate",
            Self::Interrupt => "interrupt",
        }
    }

    fn expected_status(self) -> CompletionStatus {
        match self {
            Self::Interrupt => CompletionStatus::Interrupted,
            _ => CompletionStatus::Completed,
        }
    }
}

#[derive(Default)]
struct ModelControls {
    pending: Notify,
    requests: Mutex<Vec<ControlRequestEnvelope>>,
}

#[async_trait]
impl ControlSink for ModelControls {
    async fn request(
        &self,
        envelope: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.requests.lock().unwrap().push(envelope.clone());
        let ControlRequest::UserQuestion { questions } = &envelope.request else {
            panic!("expected a single choice");
        };
        let [question] = questions.as_slice() else {
            panic!("expected one question");
        };
        let selected = match question.prompt.as_str() {
            "select" => question.options[question.options.len() / 2].id.clone(),
            "unknown" => "not-advertised".to_owned(),
            "interrupt" => {
                self.pending.notify_one();
                std::future::pending().await
            }
            _ => panic!("malformed permission request reached the consumer"),
        };

        Ok(ControlResolution {
            request_id: envelope.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
                question_id: question.id.clone(),
                selected_option_ids: vec![selected],
                free_form: None,
            }])),
            message: None,
        })
    }
}

#[test]
fn generated_turn_sequences_match_the_lifecycle_model_and_wire_oracle() {
    Hegel::new(|tc: TestCase| {
        let steps = tc.draw(gs::integers::<usize>().max_value(8));
        let trace: Vec<_> = (0..steps)
            .map(|_| {
                let operation = match tc.draw(gs::integers::<u8>().max_value(3)) {
                    0 => Operation::Select,
                    1 => Operation::Unknown,
                    2 => Operation::Duplicate,
                    _ => Operation::Interrupt,
                };
                let options = tc.draw(gs::integers::<usize>().min_value(2).max_value(8));
                (operation, options)
            })
            .collect();
        tc.note(&format!("{trace:?}"));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            timeout(Duration::from_secs(10), check_trace(trace))
                .await
                .expect("ACP model trace timed out");
        });
    })
    .settings(Settings::new().test_cases(40))
    .run();
}

async fn check_trace(trace: Vec<(Operation, usize)>) {
    let fixture = format!("{}/tests/fixtures/agent.py", env!("CARGO_MANIFEST_DIR"));
    let runtime = AcpRuntime::new(
        "/usr/bin/env".into(),
        vec!["python3".into(), fixture, "--model".into()],
        Default::default(),
    );
    let workspace = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let controls = Arc::new(ModelControls::default());
    let session = start(
        &runtime,
        workspace.path().into(),
        events.clone(),
        controls.clone(),
    )
    .await
    .unwrap();

    assert!(matches!(
        events.0.lock().await[0].payload,
        Event::SessionStarted(_)
    ));
    let mut expected_requests = 0;
    for (index, (operation, options)) in trace.iter().copied().enumerate() {
        let id = format!("turn-{index}");
        let content = json!([operation.wire_scenario(), options]).to_string();
        let handle = session.send(turn(&id, &content)).await.unwrap();
        if matches!(operation, Operation::Interrupt) {
            controls.pending.notified().await;
            assert!(session.send(turn("busy", "unaccepted")).await.is_err());
            handle.interrupt().await.unwrap();
            handle.interrupt().await.unwrap();
        }

        let outcome = handle.await_outcome().await.unwrap();
        assert_eq!(outcome.status, operation.expected_status());
        {
            let requests = controls.requests.lock().unwrap();
            if !matches!(operation, Operation::Duplicate) {
                let request = &requests[expected_requests];
                let ControlRequest::UserQuestion { questions } = &request.request else {
                    panic!("expected a single choice");
                };
                let [question] = questions.as_slice() else {
                    panic!("expected one question");
                };
                let labels: HashSet<_> = question
                    .options
                    .iter()
                    .map(|option| &option.label)
                    .collect();
                assert_eq!(question.options.len(), options);
                assert_eq!(labels.len(), options);
                assert!(!question.multiple && !question.free_form);
                assert_eq!(question.prompt, operation.wire_scenario());
                assert_eq!(request.turn_id.as_ref().unwrap().as_str(), id);
                expected_requests += 1;
            }
            assert_eq!(requests.len(), expected_requests);
        }
        let delivered = events.0.lock().await;
        let previous = 1 + index * 2;
        assert_eq!(delivered.len(), previous + 2);
        let started = &delivered[previous];
        let finished = &delivered[previous + 1];
        assert!(matches!(started.payload, Event::TurnStarted(_)));
        assert_eq!(finished.payload, Event::TurnFinished(outcome));
        for (event_index, event) in [(previous, started), (previous + 1, finished)] {
            assert_eq!(event.sequence, (event_index + 1) as u64);
            assert_eq!(event.correlation.turn_id.as_ref().unwrap().as_str(), id);
        }
    }

    let closed = session.close().await.unwrap();
    assert_eq!(closed.status, SessionCloseStatus::Closed);
    assert_eq!(session.close().await.unwrap(), closed);
    assert!(session.send(turn("closed", "unaccepted")).await.is_err());
    let delivered = events.0.lock().await;
    assert_eq!(delivered.len(), 2 + trace.len() * 2);
    assert_eq!(
        delivered.last().unwrap().payload,
        Event::SessionClosed(closed)
    );
}

mod configuration;

mod one_shot;
