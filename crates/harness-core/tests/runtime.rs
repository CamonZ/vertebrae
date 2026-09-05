mod common;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use async_trait::async_trait;
use vertebrae_harness_core::*;

use common::outcome;

struct CountingIds(AtomicU64);

impl EventIdGenerator for CountingIds {
    fn next_id(&self) -> EventId {
        EventId::from(format!("event-{}", self.0.fetch_add(1, Ordering::SeqCst)))
    }
}

#[derive(Default)]
struct CapturingSink(Mutex<Vec<HarnessEventV1>>);

#[async_trait]
impl EventSink for CapturingSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}

struct FailOnceSink {
    failed: Mutex<bool>,
    captured: Mutex<Vec<HarnessEventV1>>,
}

struct BlockingSink {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl EventSink for BlockingSink {
    async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(())
    }
}

#[async_trait]
impl EventSink for FailOnceSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        let mut failed = self.failed.lock().unwrap();
        if !*failed {
            *failed = true;
            return Err(HarnessError::EventSink("transient".into()));
        }
        self.captured.lock().unwrap().push(event);
        Ok(())
    }
}

#[tokio::test]
async fn sequenced_sink_assigns_ids_and_sequences_per_stream() {
    let sequencer = Arc::new(EventSequencer::new(Arc::new(CountingIds(AtomicU64::new(
        1,
    )))));
    let captured = Arc::new(CapturingSink::default());
    let sink = SequencedEventSink::new(sequencer, captured.clone());

    let a1 = sink
        .emit(HarnessEventDraftV1::new(
            "a",
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "a1".into(),
                ..Default::default()
            }),
        ))
        .await
        .unwrap();
    let b1 = sink
        .emit(HarnessEventDraftV1::new(
            "b",
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "b1".into(),
                ..Default::default()
            }),
        ))
        .await
        .unwrap();
    let a2 = sink
        .emit(HarnessEventDraftV1::new(
            "a",
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "a2".into(),
                ..Default::default()
            }),
        ))
        .await
        .unwrap();

    assert_eq!((a1.sequence, b1.sequence, a2.sequence), (1, 1, 2));
    assert_eq!(a1.event_id, EventId::from("event-1"));
    assert_eq!(captured.0.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn ambiguous_dispatch_failure_closes_only_the_affected_stream() {
    let sequencer = Arc::new(EventSequencer::new(Arc::new(CountingIds(AtomicU64::new(
        1,
    )))));
    let downstream = Arc::new(FailOnceSink {
        failed: Mutex::new(false),
        captured: Mutex::new(Vec::new()),
    });
    let sink = SequencedEventSink::new(sequencer, downstream.clone());
    let draft = |stream| {
        HarnessEventDraftV1::new(
            stream,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "x".into(),
                ..Default::default()
            }),
        )
    };

    assert!(sink.emit(draft("stream")).await.is_err());
    assert!(sink.emit(draft("stream")).await.is_err());
    let other_stream = sink.emit(draft("other")).await.unwrap();
    assert_eq!(other_stream.sequence, 1);
    assert_eq!(
        downstream.captured.lock().unwrap()[0].stream_id.as_str(),
        "other"
    );
}

#[tokio::test]
async fn cancelling_dispatch_fails_the_reserved_stream_closed() {
    let downstream = Arc::new(BlockingSink {
        started: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let sink = Arc::new(SequencedEventSink::new(
        Arc::new(EventSequencer::default()),
        downstream.clone(),
    ));
    let task_sink = sink.clone();
    let task = tokio::spawn(async move {
        task_sink
            .emit(HarnessEventDraftV1::new(
                "stream",
                UpdateSemantics::Delta,
                HarnessEventPayloadV1::Text(TextEvent {
                    text: "x".into(),
                    ..Default::default()
                }),
            ))
            .await
    });
    downstream.started.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        sink.emit(HarnessEventDraftV1::new(
            "stream",
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "y".into(),
                ..Default::default()
            }),
        ))
        .await
        .is_err()
    );
}

#[derive(Default)]
struct CapturingControlSink(Mutex<Vec<ControlRequestEnvelope>>);

#[async_trait]
impl ControlSink for CapturingControlSink {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.0.lock().unwrap().push(request.clone());
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(ControlDecision::AllowOnce),
            message: None,
        })
    }
}

struct MockTurn {
    id: TurnId,
    interrupted: AtomicBool,
    status: CompletionStatus,
}

struct BlockingTurn {
    id: TurnId,
    awaiting: tokio::sync::Notify,
    interrupted: AtomicBool,
    released: tokio::sync::Notify,
}

#[async_trait]
impl TurnHandle for BlockingTurn {
    fn turn_id(&self) -> &TurnId {
        &self.id
    }

    async fn interrupt(&self) -> Result<(), HarnessError> {
        self.interrupted.store(true, Ordering::SeqCst);
        self.released.notify_one();
        Ok(())
    }

    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        self.awaiting.notify_one();
        self.released.notified().await;
        Ok(outcome(if self.interrupted.load(Ordering::SeqCst) {
            CompletionStatus::Interrupted
        } else {
            CompletionStatus::Completed
        }))
    }
}

#[async_trait]
impl TurnHandle for MockTurn {
    fn turn_id(&self) -> &TurnId {
        &self.id
    }

    async fn interrupt(&self) -> Result<(), HarnessError> {
        self.interrupted.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        Ok(outcome(if self.interrupted.load(Ordering::SeqCst) {
            CompletionStatus::Interrupted
        } else {
            self.status
        }))
    }
}

struct MockSession {
    id: SessionId,
    resume_id: Option<ProviderResumeId>,
    closed: AtomicBool,
    close_status: SessionCloseStatus,
}

#[async_trait]
impl SessionHandle for MockSession {
    fn session_id(&self) -> &SessionId {
        &self.id
    }

    fn provider_resume_id(&self) -> Option<&ProviderResumeId> {
        self.resume_id.as_ref()
    }

    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(HarnessError::InvalidRequest("session is closed".into()));
        }
        Ok(Arc::new(MockTurn {
            id: request.turn_id,
            interrupted: AtomicBool::new(false),
            status: match request.content.as_str() {
                "fail" => CompletionStatus::Failed,
                "cancel" => CompletionStatus::Cancelled,
                _ => CompletionStatus::Completed,
            },
        }))
    }

    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        self.closed.store(true, Ordering::SeqCst);
        Ok(SessionCloseOutcome {
            status: self.close_status,
            error: (self.close_status != SessionCloseStatus::Closed)
                .then(|| "session ended".into()),
        })
    }
}

struct MockRun {
    id: RunId,
    cancelled: AtomicBool,
    status: CompletionStatus,
}

#[async_trait]
impl RunHandle for MockRun {
    fn run_id(&self) -> &RunId {
        &self.id
    }

    async fn cancel(&self) -> Result<(), HarnessError> {
        self.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        Ok(RunOutcome {
            status: if self.cancelled.load(Ordering::SeqCst) {
                CompletionStatus::Cancelled
            } else {
                self.status
            },
            result_text: Some("run".into()),
            structured_output: None,
            usage: None,
            metrics: OutcomeMetrics::default(),
            error: None,
        })
    }
}

#[derive(Default)]
struct MockRuntime {
    starts: Mutex<Vec<StartSessionRequest>>,
    runs: Mutex<Vec<RunRequest>>,
}

#[async_trait]
impl HarnessRuntime for MockRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        Ok(HarnessCapabilities {
            provider: "mock".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: true,
            one_shot_runs: true,
            session_resumption: true,
            default_model: None,
            models: Vec::new(),
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: Default::default(),
            questions: QuestionCapabilities::default(),
        })
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        self.starts.lock().unwrap().push(request.clone());
        let close_status = match request.session_id.as_str() {
            "lost" => SessionCloseStatus::ProcessLost,
            "failed" => SessionCloseStatus::Failed,
            _ => SessionCloseStatus::Closed,
        };
        Ok(Arc::new(MockSession {
            id: request.session_id,
            resume_id: request.resume_id,
            closed: AtomicBool::new(false),
            close_status,
        }))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        self.runs.lock().unwrap().push(request.clone());
        let status = if request.prompt == "fail" {
            CompletionStatus::Failed
        } else {
            CompletionStatus::Completed
        };
        Ok(Arc::new(MockRun {
            id: request.run_id,
            cancelled: AtomicBool::new(false),
            status,
        }))
    }
}

#[tokio::test]
async fn resumed_and_new_sessions_use_one_start_path_and_survive_turn_completion() {
    let runtime = MockRuntime::default();
    let events = Arc::new(CapturingSink::default());
    let controls = Arc::new(CapturingControlSink::default());

    let resumed = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("session"),
                stream_id: StreamId::from("stream"),
                resume_id: Some(ProviderResumeId::from("provider-resume")),
                config: RequestConfig::default(),
            },
            events.clone(),
            controls.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        resumed.provider_resume_id().unwrap().as_str(),
        "provider-resume"
    );

    let turn = resumed
        .send(SendTurnRequest {
            turn_id: TurnId::from("turn-1"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    assert_eq!(
        turn.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );

    let second_turn = resumed
        .send(SendTurnRequest {
            turn_id: TurnId::from("turn-2"),
            content: "again".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    second_turn.interrupt().await.unwrap();
    assert_eq!(
        second_turn.await_outcome().await.unwrap().status,
        CompletionStatus::Interrupted
    );

    for (content, expected) in [
        ("fail", CompletionStatus::Failed),
        ("cancel", CompletionStatus::Cancelled),
        ("still usable", CompletionStatus::Completed),
    ] {
        let turn = resumed
            .send(SendTurnRequest {
                turn_id: TurnId::from(format!("turn-{content}")),
                content: content.into(),
                output_schema: None,
            })
            .await
            .unwrap();
        assert_eq!(turn.await_outcome().await.unwrap().status, expected);
    }
    assert_eq!(
        resumed.close().await.unwrap().status,
        SessionCloseStatus::Closed
    );

    let new_session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("new"),
                stream_id: StreamId::from("new-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            events,
            controls,
        )
        .await
        .unwrap();
    assert!(new_session.provider_resume_id().is_none());
    assert_eq!(runtime.starts.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_shared_turn_handle_can_be_interrupted_while_outcome_is_awaited() {
    let turn = Arc::new(BlockingTurn {
        id: TurnId::from("turn"),
        awaiting: tokio::sync::Notify::new(),
        interrupted: AtomicBool::new(false),
        released: tokio::sync::Notify::new(),
    });
    let waiter = turn.clone();
    let interrupter = turn.clone();
    let (outcome, interrupt) =
        tokio::join!(async move { waiter.await_outcome().await }, async move {
            interrupter.awaiting.notified().await;
            interrupter.interrupt().await
        });
    interrupt.unwrap();
    assert_eq!(outcome.unwrap().status, CompletionStatus::Interrupted);
}

#[tokio::test]
async fn one_shot_cancel_yields_run_outcome_not_session_outcome() {
    let runtime = MockRuntime::default();
    let run = runtime
        .run_once(
            RunRequest {
                run_id: RunId::from("run"),
                stream_id: StreamId::from("stream"),
                prompt: "work".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CapturingSink::default()),
            Arc::new(CapturingControlSink::default()),
        )
        .await
        .unwrap();
    run.cancel().await.unwrap();
    assert_eq!(
        run.await_outcome().await.unwrap().status,
        CompletionStatus::Cancelled
    );
}

#[tokio::test]
async fn one_shot_and_session_handles_preserve_all_terminal_scopes() {
    let runtime = MockRuntime::default();
    let events = Arc::new(CapturingSink::default());
    let controls = Arc::new(CapturingControlSink::default());
    for (prompt, expected) in [
        ("work", CompletionStatus::Completed),
        ("fail", CompletionStatus::Failed),
    ] {
        let run = runtime
            .run_once(
                RunRequest {
                    run_id: RunId::from(format!("run-{prompt}")),
                    stream_id: StreamId::from(format!("stream-{prompt}")),
                    prompt: prompt.into(),
                    config: RequestConfig::default(),
                },
                events.clone(),
                controls.clone(),
            )
            .await
            .unwrap();
        assert_eq!(run.await_outcome().await.unwrap().status, expected);
    }

    for (session_id, expected) in [
        ("closed", SessionCloseStatus::Closed),
        ("lost", SessionCloseStatus::ProcessLost),
        ("failed", SessionCloseStatus::Failed),
    ] {
        let session = runtime
            .start_session(
                StartSessionRequest {
                    session_id: SessionId::from(session_id),
                    stream_id: StreamId::from(format!("stream-{session_id}")),
                    resume_id: None,
                    config: RequestConfig::default(),
                },
                events.clone(),
                controls.clone(),
            )
            .await
            .unwrap();
        assert_eq!(session.close().await.unwrap().status, expected);
    }
}

#[tokio::test]
async fn control_sink_preserves_correlation_and_resolution_source() {
    let sink = CapturingControlSink::default();
    let request = ControlRequestEnvelope {
        request_id: ControlRequestId::from("request"),
        session_id: Some(SessionId::from("session")),
        turn_id: Some(TurnId::from("turn")),
        thread_id: Some(ThreadId::from("thread")),
        is_root: Some(true),
        request: ControlRequest::PermissionGrant(PermissionGrantRequest {
            permissions: vec!["filesystem".into()],
            scope_supported: vec![GrantScope::Turn, GrantScope::Session],
        }),
        presentation: None,
        timeout_ms: Some(500),
        automatic_resolution: Some(ControlDecision::Deny),
    };
    let resolution = sink.request(request.clone()).await.unwrap();
    assert_eq!(resolution.request_id, request.request_id);
    assert_eq!(resolution.source, ResolutionSource::Consumer);
    assert_eq!(sink.0.lock().unwrap()[0].turn_id, request.turn_id);
}

#[tokio::test]
async fn durable_control_events_bracket_the_live_control_exchange() {
    let captured = Arc::new(CapturingSink::default());
    let events = SequencedEventSink::new(Arc::new(EventSequencer::default()), captured.clone());
    let controls = CapturingControlSink::default();
    let request = ControlRequestEnvelope {
        request_id: ControlRequestId::from("request"),
        session_id: Some(SessionId::from("session")),
        turn_id: Some(TurnId::from("turn")),
        thread_id: Some(ThreadId::from("thread")),
        is_root: Some(true),
        request: ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::FileChange,
            title: "Apply changes?".into(),
            details: None,
            modification_supported: false,
        }),
        presentation: None,
        timeout_ms: Some(100),
        automatic_resolution: Some(ControlDecision::Deny),
    };
    let mut draft = HarnessEventDraftV1::new(
        "stream",
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ControlRequested(request.clone()),
    );
    draft.correlation.session_id = request.session_id.clone();
    draft.correlation.turn_id = request.turn_id.clone();
    events.emit(draft).await.unwrap();

    let resolution = controls.request(request).await.unwrap();
    let mut draft = HarnessEventDraftV1::new(
        "stream",
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ControlResolved(resolution),
    );
    draft.correlation.session_id = Some(SessionId::from("session"));
    draft.correlation.turn_id = Some(TurnId::from("turn"));
    events.emit(draft).await.unwrap();

    let emitted = captured.0.lock().unwrap();
    assert!(matches!(
        emitted[0].payload,
        HarnessEventPayloadV1::ControlRequested(_)
    ));
    assert!(matches!(
        emitted[1].payload,
        HarnessEventPayloadV1::ControlResolved(_)
    ));
    assert_eq!(emitted[0].correlation, emitted[1].correlation);
}
