//! Runs the real App Server runtime against a scripted server that sends each
//! fixture phase only when the test asks, so the test waits on delivered
//! events instead of sleeping.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Notify, mpsc},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use vertebrae_harness_codex::{
    CodexAppServerEndpoint, CodexAppServerLauncher, CodexProviderConfig, CodexRuntime,
    LaunchedCodexAppServer,
};
use vertebrae_harness_core::{
    BackgroundWorkStatus, CompletionStatus, ControlDecision, ControlRequestEnvelope,
    ControlResolution, ControlSink, EventId, EventSink, HarnessError, HarnessEventPayloadV1,
    HarnessEventV1, HarnessRuntime, ResolutionSource, SendTurnRequest, SessionHandle, SessionId,
    SessionMode, StartSessionRequest, StreamId, ThreadId, TurnId,
};

const FIXTURE: &str = include_str!("fixtures/background/codex-0.169.0.jsonl");
const EXPECTED: &str = include_str!("fixtures/background/codex-0.169.0.expected.json");

#[derive(Clone)]
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

struct AutomaticControl;

#[async_trait]
impl ControlSink for AutomaticControl {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(ControlDecision::AllowOnce),
            message: None,
        })
    }
}

#[derive(Default)]
struct ObservedSink {
    events: std::sync::Mutex<Vec<HarnessEventV1>>,
    changed: Notify,
}

#[async_trait]
impl EventSink for ObservedSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.events.lock().unwrap().push(event);
        self.changed.notify_waiters();
        Ok(())
    }
}

impl ObservedSink {
    fn snapshot(&self) -> Vec<HarnessEventV1> {
        self.events.lock().unwrap().clone()
    }

    /// The timeout only bounds a failing test.
    async fn until(&self, label: &str, predicate: impl Fn(&[HarnessEventV1]) -> bool) {
        let wait = async {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();

                if predicate(&self.events.lock().unwrap()) {
                    return;
                }
                notified.await;
            }
        };

        tokio::time::timeout(Duration::from_secs(10), wait)
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {label}"));
    }
}

fn phase(name: &str) -> Vec<Value> {
    FIXTURE
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|frame| frame["phase"] == name)
        .map(|frame| json!({"method": frame["method"], "params": frame["params"]}))
        .collect()
}

/// Answers requests and sends a fixture phase whenever the test pushes one.
async fn scripted_server() -> (
    String,
    mpsc::UnboundedSender<Vec<Value>>,
    Arc<Mutex<Vec<String>>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (script_tx, mut script_rx) = mpsc::unbounded_channel::<Vec<Value>>();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let mut turns = 0;

        loop {
            tokio::select! {
                frames = script_rx.recv() => {
                    let Some(frames) = frames else { break };
                    for frame in frames {
                        socket.send(Message::Text(frame.to_string())).await.unwrap();
                    }
                }
                frame = socket.next() => {
                    let Some(Ok(Message::Text(text))) = frame else { break };
                    let request: Value = serde_json::from_str(&text).unwrap();
                    let Some(method) = request.get("method").and_then(Value::as_str) else { continue };
                    captured.lock().await.push(method.to_owned());

                    let Some(id) = request.get("id") else { continue };
                    let result = match method {
                        "thread/start" => json!({"thread": {"id": "root-thread"}}),
                        "turn/start" => {
                            turns += 1;
                            json!({"turn": {"id": format!("provider-turn-{turns}")}})
                        }
                        _ => json!({}),
                    };

                    socket.send(Message::Text(json!({"id": id, "result": result}).to_string())).await.unwrap();
                }
            }
        }
    });

    (format!("ws://{address}"), script_tx, requests)
}

fn work_view(event: &HarnessEventV1) -> Option<Value> {
    let HarnessEventPayloadV1::BackgroundWork(work) = &event.payload else {
        return None;
    };

    let mut value = json!({
        "work": work.work_id.as_str(),
        "generation": work.generation,
        "status": work.status,
    });
    let optional = [
        (
            "launch",
            work.launch_tool_call_id.as_ref().map(ToString::to_string),
        ),
        ("description", work.description.clone()),
        ("progress", work.progress.clone()),
        ("error", work.error.clone()),
    ];

    for (key, field) in optional {
        if let Some(field) = field {
            value[key] = json!(field);
        }
    }

    Some(value)
}

fn turn_inputs(events: &[HarnessEventV1]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event.payload, HarnessEventPayloadV1::TurnInput(_)))
        .count()
}

fn root_finished(events: &[HarnessEventV1], turn: &str) -> bool {
    events.iter().any(|event| {
        event.correlation.turn_id.as_ref() == Some(&TurnId::from(turn))
            && matches!(event.payload, HarnessEventPayloadV1::TurnFinished(_))
    })
}

fn turn(id: &str) -> SendTurnRequest {
    SendTurnRequest {
        turn_id: TurnId::from(id),
        content: "go".into(),
        output_schema: None,
        settings: Default::default(),
    }
}

async fn start_session(url: String, sink: Arc<ObservedSink>) -> Arc<dyn SessionHandle> {
    let runtime = CodexRuntime::new(CodexProviderConfig {
        launcher: Some(Arc::new(TestLauncher { url })),
        ..Default::default()
    });

    runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("surface-session"),
                stream_id: StreamId::new("stream"),
                mode: SessionMode::New,
                config: Default::default(),
            },
            sink,
            Arc::new(AutomaticControl),
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_commands_stay_visible_after_the_reply_and_settle_later() {
    let expected: Value = serde_json::from_str(EXPECTED).unwrap();
    let (url, script, _requests) = scripted_server().await;
    let sink = Arc::new(ObservedSink::default());
    let session = start_session(url, sink.clone()).await;
    let session_id = session.session_id().clone();

    // Turn 1 backgrounds two commands, runs one in the foreground and
    // spawns a subagent, which is not background work.
    let first = session.send(turn("turn-1")).await.unwrap();
    sink.until("turn-1 started", |events| turn_inputs(events) >= 1)
        .await;
    script.send(phase("turn1")).unwrap();

    assert_eq!(
        first.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let launched: Vec<Value> = sink.snapshot().iter().filter_map(work_view).collect();

    assert_eq!(
        launched,
        expected["events"].as_array().unwrap()[..2],
        "both commands are running when the reply ends"
    );

    // With no turn running, only the idle pump can deliver this phase. It also
    // contains a command on a thread this session does not own.
    script.send(phase("idle")).unwrap();
    sink.until("post-reply command outcome", |events| {
        events
            .iter()
            .filter_map(work_view)
            .any(|work| work["status"] == "completed")
    })
    .await;

    let idle = sink.snapshot();
    let foreign = ThreadId::from("foreign-thread");

    assert!(
        idle.iter()
            .all(|event| event.correlation.thread_id.as_ref() != Some(&foreign)),
        "idle consumption must not expose unrelated threads"
    );

    // During turn 2 the other command fails, reported twice under its
    // original turn.
    let second = session.send(turn("turn-2")).await.unwrap();
    sink.until("turn-2 started", |events| turn_inputs(events) >= 2)
        .await;
    script.send(phase("turn2")).unwrap();

    assert_eq!(
        second.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );

    sink.until("turn-2 finished", |events| root_finished(events, "turn-2"))
        .await;

    let events = sink.snapshot();
    let observed: Vec<Value> = events.iter().filter_map(work_view).collect();

    assert_eq!(Value::Array(observed), expected["events"]);

    for event in events.iter().filter(|event| work_view(event).is_some()) {
        assert_eq!(event.correlation.session_id.as_ref(), Some(&session_id));
        assert_eq!(
            event.correlation.thread_id.as_ref(),
            Some(&ThreadId::from("root-thread"))
        );
    }

    // Outcomes keep the session and thread of the work; the turn they arrive
    // in does not take it over.
    let launches = events.iter().filter(|event| {
        matches!(&event.payload, HarnessEventPayloadV1::BackgroundWork(work) if work.status == BackgroundWorkStatus::Running)
    });
    for event in launches {
        assert_eq!(event.correlation.turn_id, Some(TurnId::from("turn-1")));
    }

    assert_gui_golden(&events);

    session.close().await.unwrap();
}

/// Writes the input of the GUI bridge test, with runtime ids and clock values
/// replaced. Set `VERTEBRAE_UPDATE_GOLDEN=1` to rewrite it.
fn assert_gui_golden(events: &[HarnessEventV1]) {
    let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../gui/src-tauri/src/local_chat/harnesses/fixtures/background-codex.harness.json");
    let bridged = events.iter().filter(|event| {
        event.stream_id.as_str() == "stream"
            && matches!(
                event.payload,
                HarnessEventPayloadV1::BackgroundWork(_)
                    | HarnessEventPayloadV1::TurnStarted(_)
                    | HarnessEventPayloadV1::TurnFinished(_)
            )
    });

    let normalized: Vec<HarnessEventV1> = bridged
        .enumerate()
        .map(|(index, event)| {
            let sequence = index as u64 + 1;
            let mut event = event.clone();

            event.event_id = EventId::new(format!("codex-{sequence}"));
            event.stream_id = StreamId::new("local-chat:backend-1");
            event.sequence = sequence;
            event.timestamp =
                chrono::DateTime::from_timestamp(1_800_000_000 + sequence as i64, 0).unwrap();

            event
        })
        .collect();

    let actual = serde_json::to_string_pretty(&normalized).unwrap() + "\n";
    if std::env::var_os("VERTEBRAE_UPDATE_GOLDEN").is_some() {
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|error| panic!("{}: {error}", golden_path.display()));

    assert_eq!(
        actual, golden,
        "regenerate with VERTEBRAE_UPDATE_GOLDEN=1 after review"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_session_stops_the_idle_pump() {
    let (url, script, requests) = scripted_server().await;
    let sink = Arc::new(ObservedSink::default());
    let session = start_session(url, sink.clone()).await;

    let first = session.send(turn("turn-1")).await.unwrap();
    sink.until("turn-1 started", |events| turn_inputs(events) >= 1)
        .await;
    script.send(phase("turn1")).unwrap();
    first.await_outcome().await.unwrap();

    session.close().await.unwrap();

    assert!(
        requests
            .lock()
            .await
            .iter()
            .any(|method| method == "thread/unsubscribe")
    );

    let delivered = sink.snapshot().len();
    let _ = script.send(phase("idle"));
    tokio::task::yield_now().await;

    assert_eq!(sink.snapshot().len(), delivered);
}
