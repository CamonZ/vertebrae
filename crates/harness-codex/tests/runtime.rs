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
    HarnessEventPayloadV1, HarnessRuntime, RunRequest, SessionId, StartSessionRequest, StreamId,
    TurnInputProvenance,
};

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

#[derive(Default)]
struct CapturingSink {
    events: Mutex<Vec<vertebrae_harness_core::HarnessEventV1>>,
}

#[async_trait]
impl EventSink for CapturingSink {
    async fn emit(
        &self,
        event: vertebrae_harness_core::HarnessEventV1,
    ) -> Result<(), HarnessError> {
        self.events.lock().unwrap().push(event);
        Ok(())
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

async fn mock_server() -> (String, tokio::task::JoinHandle<()>, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured_requests = Arc::clone(&requests);
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
            captured_requests.lock().unwrap().push(method.to_string());
            let Some(id) = request.get("id") else {
                continue;
            };
            match method {
                "initialize" => socket.send(Message::Text(json!({"id": id, "result": {"capabilities": {}}}).to_string())).await.unwrap(),
                "thread/start" => socket.send(Message::Text(json!({"id": id, "result": {"thread": {"id": "root-thread"}, "model": "gpt-test"}}).to_string())).await.unwrap(),
                "turn/start" => {
                    socket.send(Message::Text(json!({"id": id, "result": {"turn": {"id": "turn-1"}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"turn/started","params":{"threadId":"root-thread","turn":{"id":"turn-1","status":"inProgress"}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"root-thread","name":"node_repl","status":"ready"}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":21}}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"item/agentMessage/delta","params":{"threadId":"root-thread","turnId":"turn-1","delta":"hello"}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"item/completed","params":{"threadId":"root-thread","turnId":"turn-1","item":{"type":"agentMessage","text":"hello"}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":"root-thread","turn":{"id":"turn-1","status":"completed","durationMs":12}}}).to_string())).await.unwrap();
                }
                "skills/extraRoots/set" => socket.send(Message::Text(json!({"id": id, "result": {}}).to_string())).await.unwrap(),
                _ => socket.send(Message::Text(json!({"id": id, "result": {}}).to_string())).await.unwrap(),
            }
        }
    });
    (format!("ws://{address}"), task, requests)
}

fn runtime(url: String) -> CodexRuntime {
    CodexRuntime::new(CodexProviderConfig {
        launcher: Some(Arc::new(TestLauncher { url })),
        ..Default::default()
    })
}

#[tokio::test]
async fn persistent_session_emits_normalized_turn_and_human_input() {
    let (url, server, requests) = mock_server().await;
    let runtime = runtime(url);
    let events = Arc::new(CapturingSink::default());
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("surface-session"),
                stream_id: StreamId::new("stream"),
                resume_id: None,
                config: Default::default(),
            },
            events.clone(),
            Arc::new(AutomaticControl),
        )
        .await
        .unwrap();
    let turn = session
        .send(vertebrae_harness_core::SendTurnRequest {
            turn_id: "turn".into(),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    let events = events.events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::SessionStarted(started) if started.provider == "openai")));
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnInput(input) if input.content == "hello" && input.provenance == TurnInputProvenance::Human)));
    assert!(events.iter().any(
        |event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "hello")
    ));
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnFinished(outcome) if outcome.status == CompletionStatus::Completed)));
    assert!(
        !events
            .iter()
            .any(|event| matches!(&event.payload, HarnessEventPayloadV1::Warning(_)))
    );
    drop(events);
    session.close().await.unwrap();
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        ["initialize", "initialized", "thread/start", "turn/start"]
    );
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn one_shot_emits_run_finished_and_cleans_up() {
    let (url, server, _) = mock_server().await;
    let runtime = runtime(url);
    let events = Arc::new(CapturingSink::default());
    let run = runtime
        .run_once(
            RunRequest {
                run_id: "run-1".into(),
                stream_id: "stream".into(),
                prompt: "hello".into(),
                config: Default::default(),
            },
            events.clone(),
            Arc::new(AutomaticControl),
        )
        .await
        .unwrap();
    assert_eq!(
        run.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let events = events.events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::RunFinished(outcome) if outcome.status == CompletionStatus::Completed)));
    assert!(
        events
            .iter()
            .any(|event| matches!(&event.payload, HarnessEventPayloadV1::SessionClosed(_)))
    );
    let _ = server.await;
}
