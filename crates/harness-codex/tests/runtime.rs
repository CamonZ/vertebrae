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
    HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, RunRequest, SendTurnRequest, SessionId,
    StartSessionRequest, StreamId, TurnId, TurnInputProvenance,
};

use lifecycle::{LifecycleProbeSink, assert_balanced_turn};

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

struct SlowCapturingSink {
    events: Mutex<Vec<HarnessEventV1>>,
    delay: Duration,
}

#[async_trait]
impl EventSink for SlowCapturingSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        tokio::time::sleep(self.delay).await;
        self.events.lock().unwrap().push(event);
        Ok(())
    }
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

#[derive(Default)]
struct CapturingControl {
    requests: Mutex<Vec<vertebrae_harness_core::ControlRequestEnvelope>>,
}

#[async_trait]
impl ControlSink for CapturingControl {
    async fn request(
        &self,
        request: vertebrae_harness_core::ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.requests.lock().unwrap().push(request.clone());
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
                    socket.send(Message::Text(json!({"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"requestId":"approval-1","threadId":"root-thread","turnId":"turn-1","command":"pwd"}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"item/agentMessage/delta","params":{"threadId":"root-thread","turnId":"turn-1","delta":"hello"}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"item/started","params":{"threadId":"root-thread","turnId":"turn-1","item":{"id":"tool-1","type":"commandExecution","command":"pwd"}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"item/completed","params":{"threadId":"root-thread","turnId":"turn-1","item":{"id":"tool-1","type":"commandExecution","command":"pwd","aggregatedOutput":"/tmp","exitCode":0}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"thread/tokenUsage/updated","params":{"threadId":"root-thread","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":2,"outputTokens":3,"totalTokens":5},"total":{"inputTokens":2,"outputTokens":3,"totalTokens":5},"modelContextWindow":100}}}).to_string())).await.unwrap();
                    socket.send(Message::Text(json!({"method":"error","params":{"threadId":"root-thread","turnId":"turn-1","message":"recoverable diagnostic"}}).to_string())).await.unwrap();
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

fn runtime_with_timeouts(url: String) -> CodexRuntime {
    CodexRuntime::new(CodexProviderConfig {
        launcher: Some(Arc::new(TestLauncher { url })),
        request_timeout: Duration::from_millis(40),
        terminal_exit_timeout: Duration::from_millis(40),
        ..Default::default()
    })
}

#[derive(Clone, Copy)]
enum LifecycleScenario {
    TurnStartRejected,
    TurnStartTimeout,
    WebSocketLoss,
    DecodeFailure,
    DuplicateTerminal,
    ChildThenRootTerminal,
    InterruptCompleted,
    InterruptFallback,
    InterruptNoAck,
    NotificationLag,
    ControlledSuccess,
    StructuredValid,
    StructuredScalar,
    StructuredInvalidJson,
    StructuredSchemaViolation,
}

async fn lifecycle_server(
    scenario: LifecycleScenario,
) -> (
    String,
    tokio::task::JoinHandle<()>,
    Arc<Mutex<Vec<String>>>,
    Arc<tokio::sync::Notify>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured_requests = Arc::clone(&requests);
    let root_completion = Arc::new(tokio::sync::Notify::new());
    let server_root_completion = Arc::clone(&root_completion);
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
                "turn/start" => match scenario {
                    LifecycleScenario::TurnStartRejected => {
                        socket
                            .send(Message::Text(
                                json!({"id": id, "error": {"code": -32000, "message": "turn rejected"}})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                    }
                    LifecycleScenario::TurnStartTimeout => {}
                    _ => {
                        socket
                            .send(Message::Text(
                                json!({"id": id, "result": {"turn": {"id": "provider-turn"}}})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                        match scenario {
                            LifecycleScenario::WebSocketLoss => {
                                socket.close(None).await.unwrap();
                                break;
                            }
                            LifecycleScenario::DecodeFailure => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "item/agentMessage/delta", "params": null})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::DuplicateTerminal => {
                                for status in ["completed", "failed"] {
                                    socket
                                        .send(Message::Text(
                                            json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": status}}})
                                                .to_string(),
                                        ))
                                        .await
                                        .unwrap();
                                }
                            }
                            LifecycleScenario::ChildThenRootTerminal => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "child-thread", "turn": {"id": "child-turn", "status": "completed"}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                                server_root_completion.notified().await;
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed"}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::NotificationLag => {
                                for index in 0..700 {
                                    socket
                                        .send(Message::Text(
                                            json!({"method": "item/agentMessage/delta", "params": {"threadId": "root-thread", "turnId": "provider-turn", "delta": index.to_string()}})
                                                .to_string(),
                                        ))
                                        .await
                                        .unwrap();
                                }
                            }
                            LifecycleScenario::StructuredValid => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed", "structuredOutput": {"count": 1}}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::StructuredScalar => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed", "structuredOutput": "ok"}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::StructuredInvalidJson => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed", "result": "not json"}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::StructuredSchemaViolation => {
                                socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed", "structuredOutput": {"count": "wrong"}}}})
                                            .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            LifecycleScenario::ControlledSuccess => {
                                server_root_completion.notified().await;
                                let _ = socket
                                    .send(Message::Text(
                                        json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "completed"}}})
                                            .to_string(),
                                    ))
                                    .await;
                            }
                            LifecycleScenario::InterruptCompleted
                            | LifecycleScenario::InterruptFallback
                            | LifecycleScenario::InterruptNoAck
                            | LifecycleScenario::TurnStartRejected
                            | LifecycleScenario::TurnStartTimeout => {}
                        }
                    }
                },
                "turn/interrupt" => {
                    if matches!(scenario, LifecycleScenario::InterruptNoAck) {
                        continue;
                    }
                    socket
                        .send(Message::Text(json!({"id": id, "result": {}}).to_string()))
                        .await
                        .unwrap();
                    if matches!(scenario, LifecycleScenario::InterruptCompleted) {
                        socket
                            .send(Message::Text(
                                json!({"method": "turn/completed", "params": {"threadId": "root-thread", "turn": {"id": "provider-turn", "status": "interrupted"}}})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                    }
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
    (format!("ws://{address}"), task, requests, root_completion)
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

#[tokio::test]
async fn persistent_session_emits_normalized_turn_and_human_input() {
    let (url, server, requests) = mock_server().await;
    let runtime = runtime(url);
    let events = Arc::new(CapturingSink::default());
    let controls = Arc::new(CapturingControl::default());
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("surface-session"),
                stream_id: StreamId::new("stream"),
                resume_id: None,
                config: Default::default(),
            },
            events.clone(),
            controls.clone(),
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
    tokio::time::timeout(Duration::from_secs(2), async {
        while controls.requests.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let events = events.events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::SessionStarted(started) if started.provider == "openai")));
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnInput(input) if input.content == "hello" && input.provenance == TurnInputProvenance::Human)));
    assert!(events.iter().any(
        |event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "hello")
    ));
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnFinished(outcome) if outcome.status == CompletionStatus::Completed)));
    let correlated_root_events = events
        .iter()
        .filter(|event| {
            matches!(
                event.payload,
                HarnessEventPayloadV1::TurnStarted(_)
                    | HarnessEventPayloadV1::TurnInput(_)
                    | HarnessEventPayloadV1::Text(_)
                    | HarnessEventPayloadV1::ToolCall(_)
                    | HarnessEventPayloadV1::ToolOutput(_)
                    | HarnessEventPayloadV1::Usage(_)
                    | HarnessEventPayloadV1::Error(_)
                    | HarnessEventPayloadV1::TurnFinished(_)
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(correlated_root_events.len(), 9);
    assert!(correlated_root_events.iter().all(|event| {
        event.correlation.turn_id.as_ref() == Some(&TurnId::from("turn"))
            && event.correlation.thread_id.as_ref()
                == Some(&vertebrae_harness_core::ThreadId::from("root-thread"))
    }));
    assert!(
        !events
            .iter()
            .any(|event| { event.correlation.turn_id.as_ref() == Some(&TurnId::from("turn-1")) })
    );
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::ToolCall(tool) if tool.tool_call_id.as_str() == "tool-1"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::ToolOutput(tool) if tool.tool_call_id.as_str() == "tool-1"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::Usage(usage)
            if usage.turn_delta.as_ref().is_some_and(|usage| usage.tokens.input_tokens == 2)
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::Error(error) if error.message == "recoverable diagnostic"
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(&event.payload, HarnessEventPayloadV1::Warning(_)))
    );
    drop(events);
    let controls = controls.requests.lock().unwrap();
    assert_eq!(controls.len(), 1);
    assert_eq!(
        controls[0].session_id.as_ref(),
        Some(&SessionId::from("root-thread"))
    );
    assert_eq!(controls[0].turn_id.as_ref(), Some(&TurnId::from("turn")));
    drop(controls);
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
async fn persistent_session_satisfies_shared_lifecycle_ordering() {
    let (url, server, _) = mock_server().await;
    let runtime = runtime(url);
    let sink = Arc::new(LifecycleProbeSink::default());
    let session = start_test_session(&runtime, sink.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("shared-ordering"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();

    let outcome = sink
        .await_ordered_outcome(&turn, CompletionStatus::Completed)
        .await;
    assert_eq!(outcome.result_text.as_deref(), Some("hello"));

    session.close().await.unwrap();
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

#[tokio::test]
async fn interactive_runtime_failures_emit_one_matching_failed_terminal() {
    for (scenario, expected_error) in [
        (LifecycleScenario::TurnStartRejected, "turn rejected"),
        (LifecycleScenario::TurnStartTimeout, "request timed out"),
        (LifecycleScenario::WebSocketLoss, "websocket"),
        (LifecycleScenario::DecodeFailure, "requires object params"),
    ] {
        let (url, server, _, _) = lifecycle_server(scenario).await;
        let runtime = runtime_with_timeouts(url);
        let events = Arc::new(CapturingSink::default());
        let session = start_test_session(&runtime, events.clone()).await;
        let turn = session
            .send(SendTurnRequest {
                turn_id: TurnId::from("failed-turn"),
                content: "hello".into(),
                output_schema: None,
            })
            .await
            .unwrap();

        let outcome = tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Failed);
        assert!(
            outcome.error.as_deref().unwrap().contains(expected_error),
            "expected error containing {expected_error:?}, got {:?}",
            outcome.error
        );
        assert_balanced_turn(&events.events.lock().unwrap(), "failed-turn", &outcome);

        session.close().await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    }
}

#[tokio::test]
async fn queued_cancellation_is_balanced_without_starting_provider_work() {
    let (url, server, requests, root_completion) =
        lifecycle_server(LifecycleScenario::ControlledSuccess).await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(CapturingSink::default());
    let session = start_test_session(&runtime, events.clone()).await;
    let first = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("first"),
            content: "first".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    while !requests
        .lock()
        .unwrap()
        .iter()
        .any(|method| method == "turn/start")
    {
        tokio::task::yield_now().await;
    }
    let queued = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("queued"),
            content: "queued".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    queued.interrupt().await.unwrap();
    root_completion.notify_one();

    assert_eq!(
        first.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let queued_outcome = queued.await_outcome().await.unwrap();
    assert_eq!(queued_outcome.status, CompletionStatus::Cancelled);
    assert_balanced_turn(&events.events.lock().unwrap(), "queued", &queued_outcome);
    assert_eq!(
        requests
            .lock()
            .unwrap()
            .iter()
            .filter(|method| method.as_str() == "turn/start")
            .count(),
        1
    );

    session.close().await.unwrap();
    let _ = server.await;
}

#[tokio::test]
async fn explicit_session_close_preserves_terminal_before_outcome_ordering() {
    let (url, server, requests, root_completion) =
        lifecycle_server(LifecycleScenario::ControlledSuccess).await;
    let runtime = runtime_with_timeouts(url);
    let sink = Arc::new(LifecycleProbeSink::default());
    let session = start_test_session(&runtime, sink.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("closed"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    while !requests
        .lock()
        .unwrap()
        .iter()
        .any(|method| method == "turn/start")
    {
        tokio::task::yield_now().await;
    }
    let session_to_close = session.clone();
    let close = tokio::spawn(async move { session_to_close.close().await });

    let outcome = sink
        .await_ordered_outcome(&turn, CompletionStatus::Failed)
        .await;
    assert!(outcome.error.as_deref().unwrap().contains("closed"));
    assert_eq!(
        close.await.unwrap().unwrap().status,
        vertebrae_harness_core::SessionCloseStatus::Closed
    );
    root_completion.notify_one();
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
}

#[tokio::test]
async fn in_flight_interrupt_waits_for_provider_terminal_outcome() {
    let (url, server, requests, _) = lifecycle_server(LifecycleScenario::InterruptCompleted).await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(CapturingSink::default());
    let session = start_test_session(&runtime, events.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("interrupt"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    while !requests
        .lock()
        .unwrap()
        .iter()
        .any(|method| method == "turn/start")
    {
        tokio::task::yield_now().await;
    }
    turn.interrupt().await.unwrap();

    let outcome = turn.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Interrupted);
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .any(|method| method == "turn/interrupt")
    );
    assert_balanced_turn(&events.events.lock().unwrap(), "interrupt", &outcome);

    session.close().await.unwrap();
    let _ = server.await;
}

#[tokio::test]
async fn in_flight_interrupt_uses_bounded_interrupted_fallback() {
    for scenario in [
        LifecycleScenario::InterruptFallback,
        LifecycleScenario::InterruptNoAck,
    ] {
        let (url, server, requests, _) = lifecycle_server(scenario).await;
        let runtime = runtime_with_timeouts(url);
        let events = Arc::new(CapturingSink::default());
        let session = start_test_session(&runtime, events.clone()).await;
        let turn = session
            .send(SendTurnRequest {
                turn_id: TurnId::from("fallback"),
                content: "hello".into(),
                output_schema: None,
            })
            .await
            .unwrap();
        while !requests
            .lock()
            .unwrap()
            .iter()
            .any(|method| method == "turn/start")
        {
            tokio::task::yield_now().await;
        }
        turn.interrupt().await.unwrap();

        let outcome = tokio::time::timeout(Duration::from_millis(200), turn.await_outcome())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Interrupted);
        assert_balanced_turn(&events.events.lock().unwrap(), "fallback", &outcome);

        session.close().await.unwrap();
        let _ = server.await;
    }
}

#[tokio::test]
async fn notification_lag_emits_one_matching_failed_terminal() {
    let (url, server, _, _) = lifecycle_server(LifecycleScenario::NotificationLag).await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(SlowCapturingSink {
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

    let outcome = tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(outcome.error.as_deref().unwrap().contains("buffer lost"));
    assert_balanced_turn(&events.events.lock().unwrap(), "lagged", &outcome);

    session.close().await.unwrap();
    let _ = server.await;
}

#[tokio::test]
async fn duplicate_provider_terminal_notifications_settle_root_once() {
    let (url, server, _, _) = lifecycle_server(LifecycleScenario::DuplicateTerminal).await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(CapturingSink::default());
    let session = start_test_session(&runtime, events.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("duplicate"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();

    let outcome = turn.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    tokio::task::yield_now().await;
    assert_balanced_turn(&events.events.lock().unwrap(), "duplicate", &outcome);

    session.close().await.unwrap();
    let _ = server.await;
}

#[tokio::test]
async fn child_terminal_does_not_settle_the_root_turn_handle() {
    let (url, server, _, root_completion) =
        lifecycle_server(LifecycleScenario::ChildThenRootTerminal).await;
    let runtime = runtime_with_timeouts(url);
    let events = Arc::new(CapturingSink::default());
    let session = start_test_session(&runtime, events.clone()).await;
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("root"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();

    loop {
        let child_finished = events.events.lock().unwrap().iter().any(|event| {
            event.correlation.turn_id.as_ref() == Some(&TurnId::from("child-turn"))
                && matches!(event.payload, HarnessEventPayloadV1::TurnFinished(_))
        });
        if child_finished {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(20), turn.await_outcome())
            .await
            .is_err(),
        "child completion must not make the root handle ready"
    );
    root_completion.notify_one();
    let outcome = turn.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    let captured = events.events.lock().unwrap();
    assert_balanced_turn(&captured, "root", &outcome);
    assert!(captured.iter().any(|event| {
        event.correlation.turn_id.as_ref() == Some(&TurnId::from("child-turn"))
            && matches!(
                &event.payload,
                HarnessEventPayloadV1::TurnFinished(child)
                    if child.status == CompletionStatus::Completed
            )
    }));
    drop(captured);

    session.close().await.unwrap();
    let _ = server.await;
}

#[tokio::test]
async fn structured_output_is_validated_before_terminal_settlement() {
    let count_schema = json!({
        "type": "object",
        "properties": {"count": {"type": "integer"}},
        "required": ["count"],
        "additionalProperties": false
    });
    for (scenario, schema, expected_status, expected_error, expected_output) in [
        (
            LifecycleScenario::StructuredValid,
            count_schema.clone(),
            CompletionStatus::Completed,
            None,
            Some(json!({"count": 1})),
        ),
        (
            LifecycleScenario::StructuredInvalidJson,
            count_schema.clone(),
            CompletionStatus::Failed,
            Some("not valid JSON"),
            None,
        ),
        (
            LifecycleScenario::StructuredScalar,
            json!({"type": "string"}),
            CompletionStatus::Completed,
            None,
            Some(json!("ok")),
        ),
        (
            LifecycleScenario::StructuredSchemaViolation,
            count_schema,
            CompletionStatus::Failed,
            Some("did not match the requested schema"),
            Some(json!({"count": "wrong"})),
        ),
        (
            LifecycleScenario::StructuredValid,
            json!({"type": 7}),
            CompletionStatus::Failed,
            Some("schema could not be compiled"),
            Some(json!({"count": 1})),
        ),
    ] {
        let (url, server, _, _) = lifecycle_server(scenario).await;
        let runtime = runtime_with_timeouts(url);
        let events = Arc::new(CapturingSink::default());
        let session = start_test_session(&runtime, events.clone()).await;
        let turn = session
            .send(SendTurnRequest {
                turn_id: TurnId::from("structured"),
                content: "return structured output".into(),
                output_schema: Some(schema),
            })
            .await
            .unwrap();

        let outcome = turn.await_outcome().await.unwrap();
        assert_eq!(outcome.status, expected_status);
        assert_eq!(outcome.structured_output, expected_output);
        match expected_error {
            Some(expected) => assert!(outcome.error.as_deref().unwrap().contains(expected)),
            None => assert!(outcome.error.is_none()),
        }
        assert_balanced_turn(&events.events.lock().unwrap(), "structured", &outcome);

        session.close().await.unwrap();
        let _ = server.await;
    }
}
