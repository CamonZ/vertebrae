#[path = "../../harness-core/tests/common/lifecycle.rs"]
mod lifecycle;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use vertebrae_harness_codex::{
    CodexAppServerLauncher, CodexProviderConfig, CodexRuntime, LaunchedCodexAppServer,
};
use vertebrae_harness_core::{
    CompletionStatus, ControlResolution, ControlSink, EventSink, HarnessError,
    HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, SendTurnRequest, SessionId,
    StartSessionRequest, StreamId, TurnId, UpdateSemantics,
};

use lifecycle::assert_balanced_turn;

#[derive(Clone)]
struct TestLauncher {
    url: String,
}

#[async_trait]
impl CodexAppServerLauncher for TestLauncher {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError> {
        Ok(LaunchedCodexAppServer {
            ws_url: self.url.clone(),
            process: None,
        })
    }
}

struct AutomaticControl;

#[async_trait]
impl ControlSink for AutomaticControl {
    async fn request(
        &self,
        request: vertebrae_harness_core::ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Ok(ControlResolution {
            request_id: request.request_id,
            source: vertebrae_harness_core::ResolutionSource::Consumer,
            decision: Some(vertebrae_harness_core::ControlDecision::AllowOnce),
            message: None,
        })
    }
}

struct SlowLiveSink {
    events: Mutex<Vec<HarnessEventV1>>,
    delay: Duration,
}

#[async_trait]
impl EventSink for SlowLiveSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        tokio::time::sleep(self.delay).await;
        self.events.lock().unwrap().push(event);
        Ok(())
    }
}

fn runtime_with_timeouts(url: String) -> CodexRuntime {
    CodexRuntime::new(CodexProviderConfig {
        launcher: Some(Arc::new(TestLauncher { url })),
        request_timeout: Duration::from_millis(40),
        terminal_exit_timeout: Duration::from_millis(40),
        ..Default::default()
    })
}

async fn start_test_session(
    runtime: &CodexRuntime,
    sink: Arc<dyn EventSink>,
) -> Arc<dyn vertebrae_harness_core::SessionHandle> {
    runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("surface-session"),
                stream_id: StreamId::new("stream"),
                resume_id: None,
                config: Default::default(),
            },
            sink,
            Arc::new(AutomaticControl),
        )
        .await
        .unwrap()
}

async fn delta_burst_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        while let Some(frame) = socket.next().await {
            let Ok(Message::Text(text)) = frame else {
                break;
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            let Some(method) = request.get("method").and_then(Value::as_str) else {
                continue;
            };
            let Some(id) = request.get("id") else {
                continue;
            };
            match method {
                "initialize" => {
                    socket
                        .send(Message::Text(
                            json!({"id": id, "result": {"capabilities": {}}}).to_string(),
                        ))
                        .await
                        .unwrap();
                }
                "thread/start" => {
                    socket
                        .send(Message::Text(
                            json!({"id": id, "result": {"thread": {"id": "root-thread"}}})
                                .to_string(),
                        ))
                        .await
                        .unwrap();
                }
                "turn/start" => {
                    socket
                        .send(Message::Text(
                            json!({"id": id, "result": {"turn": {"id": "provider-turn"}}})
                                .to_string(),
                        ))
                        .await
                        .unwrap();
                    for index in 0..700 {
                        socket
                            .send(Message::Text(
                                json!({"method": "item/agentMessage/delta", "params": {"threadId": "root-thread", "turnId": "provider-turn", "delta": index.to_string()}})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                    }
                    socket
                        .send(Message::Text(
                            json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed"}}})
                                .to_string(),
                        ))
                        .await
                        .unwrap();
                }
                _ => {
                    socket
                        .send(Message::Text(json!({"id": id, "result": {}}).to_string()))
                        .await
                        .unwrap();
                }
            }
        }
    });
    (format!("ws://{address}"), task)
}

#[tokio::test]
async fn notification_burst_over_buffer_limit_completes_without_loss() {
    let (url, server) = delta_burst_server().await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(SlowLiveSink {
        events: Mutex::new(Vec::new()),
        delay: Duration::from_millis(2),
    });
    let session = start_test_session(&runtime, events.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("lagged"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();

    let outcome = tokio::time::timeout(Duration::from_secs(5), turn.await_outcome())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    let captured_events = events.events.lock().unwrap().clone();
    assert_eq!(
        captured_events
            .iter()
            .filter(|event| {
                matches!(event.payload, HarnessEventPayloadV1::Text(_))
                    && event.semantics == UpdateSemantics::Delta
            })
            .count(),
        700
    );
    assert_balanced_turn(&captured_events, "lagged", &outcome);

    session.close().await.unwrap();
    let _ = server.await;
}
