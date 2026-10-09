use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};
use vertebrae_harness_codex::{
    CodexAppServerEndpoint, CodexAppServerLauncher, CodexCustomModelProvider, CodexProviderConfig,
    CodexRuntime, LaunchedCodexAppServer,
};
use vertebrae_harness_core::{
    CompletionStatus, ControlResolution, ControlSink, EventSink, HarnessError,
    HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, SendTurnRequest, SessionHandle,
    SessionId, SessionMode, StartSessionRequest, TurnId,
};

struct TestLauncher {
    url: String,
}

#[async_trait]
impl CodexAppServerLauncher for TestLauncher {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError> {
        Ok(LaunchedCodexAppServer {
            endpoint: CodexAppServerEndpoint::WebSocketUrl(self.url.clone()),
        })
    }
}

#[derive(Default)]
struct CapturingSink {
    events: Mutex<Vec<HarnessEventV1>>,
}

#[async_trait]
impl EventSink for CapturingSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.events.lock().unwrap().push(event);
        Ok(())
    }
}

struct AllowControl;

#[async_trait]
impl ControlSink for AllowControl {
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

type Socket = WebSocketStream<TcpStream>;

type Captured = Arc<Mutex<Vec<(usize, Value)>>>;

/// What a scripted connection does with one request. A `"close"` entry in a
/// `ResultThen` notification list drops the connection, as a daemon restart
/// does.
enum Reply {
    Result(Value),
    Error(i64, &'static str),
    ResultThen(Value, Vec<Value>),
}

/// A daemon stand-in that accepts connections in sequence; `script` maps
/// (connection index, method, params) to a reply. Unscripted methods get an
/// empty result.
async fn scripted_daemon(
    script: impl Fn(usize, &str, &Value) -> Option<Reply> + Send + Sync + 'static,
) -> (String, Captured) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let captured: Captured = Arc::default();
    let requests = Arc::clone(&captured);
    let script = Arc::new(script);
    tokio::spawn(async move {
        let mut index = 0;
        while let Ok((stream, _)) = listener.accept().await {
            let connection = index;
            index += 1;
            let requests = Arc::clone(&requests);
            let script = Arc::clone(&script);
            tokio::spawn(async move {
                let mut socket = accept_async(stream).await.unwrap();
                serve(connection, &mut socket, &requests, script.as_ref()).await;
            });
        }
    });
    (url, captured)
}

async fn serve(
    connection: usize,
    socket: &mut Socket,
    requests: &Captured,
    script: &(dyn Fn(usize, &str, &Value) -> Option<Reply> + Send + Sync),
) {
    while let Some(Ok(frame)) = socket.next().await {
        let Message::Text(text) = frame else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).unwrap();
        requests.lock().unwrap().push((connection, request.clone()));
        let (Some(id), Some(method)) = (request.get("id"), request["method"].as_str()) else {
            continue;
        };
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let reply = script(connection, method, &params).unwrap_or_else(|| match method {
            "thread/start" | "thread/resume" => {
                Reply::Result(json!({"thread": {"id": "root-thread"}, "model": "gpt-test"}))
            }
            _ => Reply::Result(json!({})),
        });
        let (response, notifications) = match reply {
            Reply::Result(result) => (json!({"id": id, "result": result}), Vec::new()),
            Reply::ResultThen(result, notifications) => {
                (json!({"id": id, "result": result}), notifications)
            }
            Reply::Error(code, message) => (
                json!({"id": id, "error": {"code": code, "message": message}}),
                Vec::new(),
            ),
        };
        socket
            .send(Message::Text(response.to_string()))
            .await
            .unwrap();
        for notification in notifications {
            if notification == json!("close") {
                let _ = socket.close(None).await;
                return;
            }
            socket
                .send(Message::Text(notification.to_string()))
                .await
                .unwrap();
        }
    }
}

fn runtime(url: String, config: CodexProviderConfig) -> CodexRuntime {
    CodexRuntime::new(CodexProviderConfig {
        launcher: Some(Arc::new(TestLauncher { url })),
        request_timeout: Duration::from_secs(2),
        ..config
    })
}

async fn start(runtime: &CodexRuntime, events: Arc<CapturingSink>) -> Arc<dyn SessionHandle> {
    runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("surface-session"),
                stream_id: "stream".into(),
                config: Default::default(),
                mode: SessionMode::New,
            },
            events,
            Arc::new(AllowControl),
        )
        .await
        .unwrap()
}

async fn send(session: &Arc<dyn SessionHandle>) -> vertebrae_harness_core::TurnOutcome {
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("turn"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), turn.await_outcome())
        .await
        .expect("turn outcome")
        .unwrap()
}

fn methods(captured: &Captured, connection: usize) -> Vec<String> {
    captured
        .lock()
        .unwrap()
        .iter()
        .filter(|(index, _)| *index == connection)
        .filter_map(|(_, request)| request["method"].as_str().map(str::to_owned))
        .collect()
}

fn request(captured: &Captured, method: &str) -> Value {
    captured
        .lock()
        .unwrap()
        .iter()
        .find(|(_, request)| request["method"] == method)
        .map(|(_, request)| request["params"].clone())
        .unwrap_or_else(|| panic!("no {method} request"))
}

#[tokio::test]
async fn reconciles_a_turn_whose_completion_was_lost_in_a_daemon_restart() {
    let (url, captured) = scripted_daemon(|connection, method, params| match (connection, method) {
        // The daemon drains the turn, then closes the connection before
        // turn/completed reaches this client.
        (0, "turn/start") => Some(Reply::ResultThen(
            json!({"turn": {"id": "provider-turn"}}),
            vec![
                json!({"method": "item/agentMessage/delta", "params": {"threadId": "root-thread", "turnId": "provider-turn", "delta": "partial"}}),
                json!("close"),
            ],
        )),
        (1, "thread/read") if params["includeTurns"] == true => Some(Reply::Result(json!({
            "thread": {"id": "root-thread", "status": {"type": "idle"}, "turns": [{
                "id": "provider-turn",
                "status": "completed",
                "items": [{"type": "agentMessage", "id": "m1", "text": "final answer"}],
            }]},
        }))),
        _ => None,
    })
    .await;
    let runtime = runtime(
        url,
        CodexProviderConfig {
            custom_model_provider: Some(CodexCustomModelProvider {
                id: "zai_glm53".into(),
                base_url: Some("https://example.invalid/v1".into()),
                api_key: Some("per-thread-secret".into()),
                wire_api: Some("responses".into()),
                environment: Default::default(),
            }),
            ..Default::default()
        },
    );
    let events = Arc::new(CapturingSink::default());
    let session = start(&runtime, events.clone()).await;

    let outcome = send(&session).await;

    assert_eq!(outcome.status, CompletionStatus::Completed, "{outcome:?}");
    assert_eq!(outcome.result_text.as_deref(), Some("final answer"));
    assert_eq!(
        methods(&captured, 1),
        ["initialize", "initialized", "thread/resume", "thread/read"]
    );
    let start = request(&captured, "thread/start");
    let resume = request(&captured, "thread/resume");
    assert_eq!(resume["threadId"], "root-thread");
    assert_eq!(
        resume["config"], start["config"],
        "per-thread config is re-sent on resume"
    );
    assert_eq!(
        resume["config"]["model_providers"]["zai_glm53"]["experimental_bearer_token"],
        "per-thread-secret"
    );
    session.close().await.unwrap();
    assert!(methods(&captured, 1).contains(&"thread/unsubscribe".to_string()));
}

#[tokio::test]
async fn reconciled_turn_without_streamed_text_uses_the_rollout_message() {
    let (url, _) = scripted_daemon(|connection, method, _| match (connection, method) {
        (0, "turn/start") => Some(Reply::ResultThen(
            json!({"turn": {"id": "provider-turn"}}),
            vec![json!("close")],
        )),
        (1, "thread/read") => Some(Reply::Result(json!({
            "thread": {"id": "root-thread", "status": {"type": "idle"}, "turns": [{
                "id": "provider-turn",
                "status": "completed",
                "items": [{"type": "agentMessage", "id": "m1", "text": "from history"}],
            }]},
        }))),
        _ => None,
    })
    .await;
    let runtime = runtime(url, CodexProviderConfig::default());
    let events = Arc::new(CapturingSink::default());
    let session = start(&runtime, events.clone()).await;

    let outcome = send(&session).await;

    assert_eq!(outcome.status, CompletionStatus::Completed, "{outcome:?}");
    assert_eq!(outcome.result_text.as_deref(), Some("from history"));
    assert!(events.events.lock().unwrap().iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::Text(text) if text.text == "from history"
    )));
    session.close().await.unwrap();
}

#[tokio::test]
async fn retries_requests_rejected_by_a_draining_daemon_after_reconnecting() {
    let (url, captured) = scripted_daemon(|connection, method, _| match (connection, method) {
        (0, "thread/start") => Some(Reply::Error(
            -32600,
            "Server is draining; retry after reconnecting",
        )),
        (1, "turn/start") => Some(Reply::Error(
            -32600,
            "Server is draining; retry after reconnecting",
        )),
        (2, "turn/start") => Some(Reply::ResultThen(
            json!({"turn": {"id": "provider-turn"}}),
            vec![
                json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed"}}}),
            ],
        )),
        _ => None,
    })
    .await;
    let runtime = runtime(url, CodexProviderConfig::default());
    let session = start(&runtime, Arc::new(CapturingSink::default())).await;

    let outcome = send(&session).await;

    assert_eq!(outcome.status, CompletionStatus::Completed, "{outcome:?}");
    assert_eq!(
        methods(&captured, 0),
        ["initialize", "initialized", "thread/start"]
    );
    assert!(methods(&captured, 1).contains(&"thread/start".to_string()));
    assert_eq!(
        methods(&captured, 2),
        ["initialize", "initialized", "thread/resume", "turn/start"]
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn ignores_broadcasts_for_threads_the_session_does_not_own() {
    let (url, _) = scripted_daemon(|_, method, _| match method {
        "turn/start" => Some(Reply::ResultThen(
            json!({"turn": {"id": "provider-turn"}}),
            vec![
                json!({"method": "thread/started", "params": {"thread": {"id": "users-own-thread"}}}),
                json!({"method": "thread/status/changed", "params": {"threadId": "users-own-thread", "status": {"type": "active", "activeFlags": []}}}),
                json!({"method": "thread/started", "params": {"thread": {"id": "child-thread", "parentThreadId": "root-thread"}}}),
                json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed"}}}),
            ],
        )),
        _ => None,
    })
    .await;
    let runtime = runtime(url, CodexProviderConfig::default());
    let events = Arc::new(CapturingSink::default());
    let session = start(&runtime, events.clone()).await;

    let outcome = send(&session).await;

    assert_eq!(outcome.status, CompletionStatus::Completed, "{outcome:?}");
    let declared: Vec<String> = events
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match &event.payload {
            HarnessEventPayloadV1::ThreadDeclared(thread) => Some(thread.thread_id.to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(declared, ["root-thread", "child-thread"]);
    session.close().await.unwrap();
}
