use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::Notify;
use vertebrae_harness_core::{
    ControlRequestEnvelope, ControlResolution, ControlSink, EventSink, HarnessError,
    HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, RequestConfig, RunId, RunRequest,
    StreamId,
};
use vertebrae_harness_typesafe::{
    Question, SystemOneRequest, TypeSafeClient, TypeSafeClientConfig, TypeSafeRuntime,
};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

struct CollectSink {
    events: Mutex<Vec<HarnessEventV1>>,
    input_emitted: Notify,
}

impl Default for CollectSink {
    fn default() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            input_emitted: Notify::new(),
        }
    }
}

#[async_trait]
impl EventSink for CollectSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        if matches!(event.payload, HarnessEventPayloadV1::TurnInput(_)) {
            self.input_emitted.notify_waiters();
        }
        self.events.lock().unwrap().push(event);
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

fn prompt() -> String {
    serde_json::to_string(&SystemOneRequest::new(
        json!({"ticket": "blocked"}),
        BTreeMap::from([(
            "is_urgent".to_string(),
            Question::noul("Should this ticket be handled urgently?"),
        )]),
    ))
    .unwrap()
}

async fn wait_for_request(server: &MockServer) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !server.received_requests().await.unwrap().is_empty() {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("TypeSafe request should reach the blocked mock server");
}

#[tokio::test]
async fn blocked_one_shot_cancellation_has_exactly_one_terminal_outcome() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(30))
                .set_body_json(json!({
                    "model": "jev-latest",
                    "answers": {"is_urgent": {"type": "noul", "noul": 0.5}},
                    "usage": {"input_tokens": 10, "output_tokens": 2}
                })),
        )
        .expect(1)
        .mount(&server)
        .await;
    let runtime = TypeSafeRuntime::new(
        TypeSafeClient::from_config(
            TypeSafeClientConfig::new("test-key")
                .with_base_url(server.uri())
                .with_timeout(Duration::from_secs(30)),
        )
        .unwrap(),
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime
        .run_once(
            RunRequest {
                run_id: RunId::from("cancelled-run"),
                stream_id: StreamId::from("cancelled-stream"),
                prompt: prompt(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(PanicControlSink),
        )
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), sink.input_emitted.notified())
        .await
        .expect("input event should be delivered before the request is cancelled");
    wait_for_request(&server).await;
    handle.cancel().await.unwrap();
    handle.cancel().await.unwrap();

    let outcome = tokio::time::timeout(Duration::from_secs(2), handle.await_outcome())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        outcome.status,
        vertebrae_harness_core::CompletionStatus::Cancelled
    );
    assert!(outcome.result_text.is_none());
    assert!(outcome.structured_output.is_none());

    let events = sink.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
            .count(),
        1
    );
    assert!(matches!(
        events.last().map(|event| &event.payload),
        Some(HarnessEventPayloadV1::RunFinished(finished))
            if finished.status == vertebrae_harness_core::CompletionStatus::Cancelled
    ));
}
