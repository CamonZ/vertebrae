use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{Value, json};
use vertebrae_harness_core::{
    CompletionStatus, ControlRequestEnvelope, ControlResolution, ControlSink, EventSink,
    HarnessCapabilities, HarnessError, HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime,
    RequestConfig, RunId, RunRequest, StartSessionRequest, StreamId, StructuredInferenceRequest,
    UsageEvent,
};
use vertebrae_harness_typesafe::{
    DEFAULT_MODEL, Question, SystemOneRequest, TypeSafeClient, TypeSafeClientConfig,
    TypeSafeRuntime,
};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

#[derive(Default)]
struct CollectSink(Mutex<Vec<HarnessEventV1>>);

#[async_trait]
impl EventSink for CollectSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}

struct PanicControlSink;

#[async_trait]
impl ControlSink for PanicControlSink {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        panic!("TypeSafe must never request a control")
    }
}

fn judgment() -> SystemOneRequest {
    SystemOneRequest::new(
        json!({"ticket": {"title": "Export fails", "body": "The export button is broken."}}),
        BTreeMap::from([(
            "is_urgent".to_string(),
            Question::noul("Does this ticket need urgent handling?"),
        )]),
    )
}

fn prompt() -> String {
    serde_json::to_string(&judgment()).unwrap()
}

fn run_request(config: RequestConfig) -> RunRequest {
    RunRequest {
        run_id: RunId::from("run-1"),
        stream_id: StreamId::from("stream-1"),
        prompt: prompt(),
        config,
    }
}

fn structured_request() -> StructuredInferenceRequest {
    StructuredInferenceRequest {
        run_id: RunId::from("run-1"),
        stream_id: StreamId::from("stream-1"),
        state: json!({"ticket": {"title": "Export fails", "body": "The export button is broken."}}),
        model: Some(DEFAULT_MODEL.into()),
        questions: BTreeMap::from([(
            "is_urgent".into(),
            json!({"type": "noul", "instructions": "Does this need urgent handling?"}),
        )]),
    }
}

fn runtime(server: &MockServer) -> TypeSafeRuntime {
    TypeSafeRuntime::new(
        TypeSafeClient::from_config(
            TypeSafeClientConfig::new("test-key")
                .with_base_url(server.uri())
                .with_timeout(Duration::from_secs(2)),
        )
        .unwrap(),
    )
}

fn success_body() -> Value {
    json!({
        "model": DEFAULT_MODEL,
        "answers": {
            "is_urgent": {"type": "noul", "noul": 0.92}
        },
        "usage": {"input_tokens": 312, "output_tokens": 48}
    })
}

#[tokio::test]
async fn capabilities_advertise_judgment_only_execution() {
    let server = MockServer::start().await;
    let capabilities = runtime(&server).capabilities().await.unwrap();

    assert_eq!(
        capabilities,
        HarnessCapabilities {
            provider: "typesafe".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: false,
            one_shot_runs: true,
            structured_inference: true,
            session_resumption: false,
            default_model: Some(DEFAULT_MODEL.into()),
            models: Vec::new(),
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: Default::default(),
            questions: Default::default(),
        }
    );
}

#[tokio::test]
async fn persistent_sessions_and_agent_options_are_rejected_without_network_work() {
    let server = MockServer::start().await;
    let runtime = runtime(&server);
    let event_sink = Arc::new(CollectSink::default());
    let control_sink = Arc::new(PanicControlSink);

    let error = match runtime
        .start_session(
            StartSessionRequest {
                session_id: "session-1".into(),
                stream_id: "stream-1".into(),
                resume_id: None,
                config: RequestConfig::default(),
            },
            event_sink.clone(),
            control_sink.clone(),
        )
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("TypeSafe must reject persistent sessions"),
    };
    assert!(
        matches!(error, HarnessError::Unsupported(message) if message.contains("persistent sessions"))
    );

    let unsupported = [
        RequestConfig {
            working_directory: Some(".".into()),
            ..Default::default()
        },
        RequestConfig {
            reasoning_effort: Some("high".into()),
            ..Default::default()
        },
        RequestConfig {
            speed_tier: Some(vertebrae_harness_core::SpeedTier::Fast),
            ..Default::default()
        },
        RequestConfig {
            personality: Some("friendly".into()),
            ..Default::default()
        },
        RequestConfig {
            verbosity: Some(vertebrae_harness_core::OutputVerbosity::Low),
            ..Default::default()
        },
        RequestConfig {
            output_schema: Some(json!({"type": "object"})),
            ..Default::default()
        },
        RequestConfig {
            developer_instructions: Some("be concise".into()),
            ..Default::default()
        },
        RequestConfig {
            environment: BTreeMap::from([("MODE".into(), "test".into())]),
            ..Default::default()
        },
    ];

    for config in unsupported {
        let error = match runtime
            .run_once(
                run_request(config),
                event_sink.clone(),
                control_sink.clone(),
            )
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("TypeSafe must reject unsupported options"),
        };
        assert!(matches!(error, HarnessError::Unsupported(_)));
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn structured_inference_sends_native_request_and_maps_answers_usage() {
    let server = MockServer::start().await;
    let state =
        json!({"ticket": {"title": "Export fails", "body": "The export button is broken."}});
    let questions = json!({
        "is_urgent": {"type": "noul", "instructions": "Does this need urgent handling?", "criteria": {"true": "blocking issue", "false": "not blocking"}},
        "category": {"type": "choice", "instructions": "Choose a category", "criteria": {"bug": "A defect", "feature": "A feature"}},
        "severity": {"type": "score", "instructions": "Rate severity", "criteria": ["low", "medium", "high"]}
    });
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .and(matchers::body_json(json!({
            "state": state,
            "model": "jev-custom",
            "questions": questions
        })))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-typesafe-request-id", "req-success")
                .set_body_json(json!({
                    "model": "jev-custom",
                    "answers": {
                        "is_urgent": {"type": "noul", "noul": 0.92},
                        "category": {"type": "choice", "choice": "bug", "probabilities": {"bug": 0.8, "feature": 0.2}, "confidence": 0.9},
                        "severity": {"type": "score", "score": 1.0, "legend": {"0": "low", "1": "medium", "2": "high"}, "probabilities": {"0": 0.1, "1": 0.8, "2": 0.1}, "confidence": 0.8}
                    },
                    "usage": {"input_tokens": 312, "output_tokens": 48}
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let sink = Arc::new(CollectSink::default());
    let handle = runtime(&server)
        .run_structured_inference(
            StructuredInferenceRequest {
                run_id: RunId::from("run-1"),
                stream_id: StreamId::from("stream-1"),
                state: state.clone(),
                model: Some("jev-custom".into()),
                questions: serde_json::from_value(questions.clone()).unwrap(),
            },
            sink.clone(),
        )
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(2), handle.await_outcome())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(outcome.status, CompletionStatus::Completed);
    assert_eq!(outcome.result_text, None);
    assert_eq!(
        outcome.structured_output,
        Some(json!({
            "is_urgent": {"type": "noul", "noul": 0.92},
            "category": {"type": "choice", "choice": "bug", "probabilities": {"bug": 0.8, "feature": 0.2}, "confidence": 0.9},
            "severity": {"type": "score", "score": 1.0, "legend": {"0": "low", "1": "medium", "2": "high"}, "probabilities": {"0": 0.1, "1": 0.8, "2": 0.1}, "confidence": 0.8}
        }))
    );
    let usage = outcome.usage.as_ref().unwrap();
    assert_eq!(usage.tokens.input_tokens, 312);
    assert_eq!(usage.tokens.output_tokens, 48);
    assert_eq!(usage.tokens.cached_input_tokens, 0);
    assert_eq!(usage.cost_microusd, 0);

    let events = sink.0.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events
            .iter()
            .map(|event| event.payload.event_type())
            .collect::<Vec<_>>(),
        vec!["turn_input", "usage", "run_finished"]
    );
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event.sequence, sequence as u64 + 1);
        assert_eq!(event.stream_id.as_str(), "stream-1");
        assert_eq!(
            event.correlation.run_id.as_ref().map(|id| id.as_str()),
            Some("run-1")
        );
        assert_eq!(
            event.correlation.thread_id.as_ref().map(|id| id.as_str()),
            Some("run-1")
        );
    }
    assert!(matches!(
        &events[0].payload,
        HarnessEventPayloadV1::TurnInput(input)
            if input.content.contains("jev-custom")
                && input.run_id.as_ref().map(|id| id.as_str()) == Some("run-1")
                && input.thread_id.as_str() == "run-1"
    ));
    assert!(matches!(
        &events[1].payload,
        HarnessEventPayloadV1::Usage(UsageEvent { turn_delta: Some(delta), session_snapshot: None })
            if delta == usage
    ));
    assert!(matches!(
        &events[2].payload,
        HarnessEventPayloadV1::RunFinished(finished) if finished == &outcome
    ));
    assert!(!events.iter().any(|event| {
        matches!(
            event.payload,
            HarnessEventPayloadV1::Text(_)
                | HarnessEventPayloadV1::ToolCall(_)
                | HarnessEventPayloadV1::ToolOutput(_)
        )
    }));
}

#[tokio::test]
async fn invalid_judgment_and_service_failures_settle_without_fabricated_output() {
    let server = MockServer::start().await;
    let runtime = runtime(&server);
    let error = match runtime
        .run_structured_inference(
            StructuredInferenceRequest {
                questions: BTreeMap::new(),
                ..structured_request()
            },
            Arc::new(CollectSink::default()),
        )
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("TypeSafe must reject invalid judgment input"),
    };
    assert!(matches!(error, HarnessError::InvalidRequest(_)));
    assert!(server.received_requests().await.unwrap().is_empty());

    for (status, request_id) in [
        (401, "req-auth"),
        (422, "req-validation"),
        (529, "req-overload"),
    ] {
        let server = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/v1/systemone"))
            .respond_with(
                ResponseTemplate::new(status).insert_header("x-typesafe-request-id", request_id),
            )
            .expect(1)
            .mount(&server)
            .await;
        let sink = Arc::new(CollectSink::default());
        let outcome = TypeSafeRuntime::new(
            TypeSafeClient::from_config(
                TypeSafeClientConfig::new("test-key")
                    .with_base_url(server.uri())
                    .with_timeout(Duration::from_secs(2)),
            )
            .unwrap(),
        )
        .run_structured_inference(structured_request(), sink.clone())
        .await
        .unwrap()
        .await_outcome()
        .await
        .unwrap();

        assert_eq!(outcome.status, CompletionStatus::Failed);
        assert!(outcome.result_text.is_none());
        assert!(outcome.structured_output.is_none());
        assert!(outcome.error.as_deref().unwrap().contains(request_id));
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn client_timeout_becomes_one_failed_terminal_outcome() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(100))
                .set_body_json(success_body()),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = TypeSafeClient::from_config(
        TypeSafeClientConfig::new("test-key")
            .with_base_url(server.uri())
            .with_timeout(Duration::from_millis(20)),
    )
    .unwrap();
    let sink = Arc::new(CollectSink::default());
    let outcome = TypeSafeRuntime::new(client)
        .run_structured_inference(structured_request(), sink.clone())
        .await
        .unwrap()
        .await_outcome()
        .await
        .unwrap();

    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(outcome.error.as_deref().unwrap().contains("timed out"));
    assert_eq!(
        sink.0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
            .count(),
        1
    );
}
