use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use vertebrae_harness_core::{
    ApprovalCategory, ApprovalRequest, CompletionStatus, ControlRequest, ControlRequestEnvelope,
    ControlSink, DiagnosticEvent, EventCorrelation, EventId, EventSink, HarnessCapabilities,
    HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, ProviderResumeId, RunHandle, RunRequest,
    SessionCloseOutcome, SessionCloseStatus, SessionHandle, SessionId, SessionStarted,
    SessionUsage, StreamId, TextEvent, TokenUsage, ToolCallEvent, ToolCallId, ToolOutputEvent,
    ToolStatus, TurnHandle, TurnId, TurnOutcome, TurnUsage, UpdateSemantics, UsageEvent,
};

use super::*;

#[derive(Default)]
struct MockRuntimeState {
    start_requests: Mutex<Vec<StartSessionRequest>>,
    event_sink: Mutex<Option<Arc<dyn EventSink>>>,
    control_sink: Mutex<Option<Arc<dyn ControlSink>>>,
    start_error: Mutex<Option<String>>,
    close_during_start: std::sync::atomic::AtomicBool,
    close_then_start_error: Mutex<Option<String>>,
}

struct MockRuntime {
    state: Arc<MockRuntimeState>,
    handle: Arc<MockSessionHandle>,
}

#[async_trait]
impl HarnessRuntime for MockRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        Err(HarnessError::Unsupported(
            "not needed by GUI adapter tests".into(),
        ))
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        self.state
            .start_requests
            .lock()
            .unwrap()
            .push(request.clone());
        *self.state.event_sink.lock().unwrap() = Some(event_sink.clone());
        *self.state.control_sink.lock().unwrap() = Some(control_sink);
        if let Some(error) = self.state.start_error.lock().unwrap().take() {
            return Err(HarnessError::Operation(error));
        }
        if self.state.close_during_start.load(Ordering::SeqCst) {
            event_sink
                .emit(HarnessEventV1 {
                    event_id: EventId::new("closed-during-start"),
                    stream_id: request.stream_id.clone(),
                    sequence: 1,
                    correlation: EventCorrelation {
                        session_id: Some(request.session_id.clone()),
                        ..EventCorrelation::default()
                    },
                    timestamp: chrono::Utc::now(),
                    semantics: UpdateSemantics::Snapshot,
                    provider_sequence: Some(1),
                    payload: HarnessEventPayloadV1::SessionClosed(SessionCloseOutcome {
                        status: SessionCloseStatus::ProcessLost,
                        error: Some("exited during startup".into()),
                    }),
                })
                .await?;
            if let Some(error) = self.state.close_then_start_error.lock().unwrap().take() {
                return Err(HarnessError::Operation(error));
            }
        }
        Ok(self.handle.clone())
    }

    async fn run_once(
        &self,
        _request: RunRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        Err(HarnessError::Unsupported("not used by GUI sessions".into()))
    }
}

struct MockSessionHandle {
    session_id: SessionId,
    provider_resume_id: Option<ProviderResumeId>,
    sent: Mutex<Vec<SendTurnRequest>>,
    send_error: Mutex<Option<String>>,
    close_count: AtomicUsize,
    close_outcome: Mutex<SessionCloseOutcome>,
    hold_close: std::sync::atomic::AtomicBool,
    close_release: Arc<tokio::sync::Notify>,
    interrupt_count: Arc<AtomicUsize>,
    interrupt_error: Arc<Mutex<Option<String>>>,
    hold_turns: Arc<std::sync::atomic::AtomicBool>,
    turn_release: Arc<tokio::sync::Notify>,
}

impl MockSessionHandle {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: SessionId::new(session_id),
            provider_resume_id: Some(ProviderResumeId::new("provider-handle-resume")),
            sent: Mutex::new(Vec::new()),
            send_error: Mutex::new(None),
            close_count: AtomicUsize::new(0),
            close_outcome: Mutex::new(SessionCloseOutcome {
                status: SessionCloseStatus::Closed,
                error: None,
            }),
            hold_close: std::sync::atomic::AtomicBool::new(false),
            close_release: Arc::new(tokio::sync::Notify::new()),
            interrupt_count: Arc::new(AtomicUsize::new(0)),
            interrupt_error: Arc::new(Mutex::new(None)),
            hold_turns: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            turn_release: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

#[async_trait]
impl SessionHandle for MockSessionHandle {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn provider_resume_id(&self) -> Option<&ProviderResumeId> {
        self.provider_resume_id.as_ref()
    }

    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if let Some(error) = self.send_error.lock().unwrap().take() {
            return Err(HarnessError::Operation(error));
        }
        let turn_id = request.turn_id.clone();
        self.sent.lock().unwrap().push(request);
        Ok(Arc::new(MockTurnHandle {
            turn_id,
            interrupt_count: self.interrupt_count.clone(),
            interrupt_error: self.interrupt_error.clone(),
            hold: self.hold_turns.clone(),
            release: self.turn_release.clone(),
        }))
    }

    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        self.close_count.fetch_add(1, Ordering::SeqCst);
        if self.hold_close.load(Ordering::SeqCst) {
            self.close_release.notified().await;
        }
        Ok(self.close_outcome.lock().unwrap().clone())
    }
}

struct MockTurnHandle {
    turn_id: TurnId,
    interrupt_count: Arc<AtomicUsize>,
    interrupt_error: Arc<Mutex<Option<String>>>,
    hold: Arc<std::sync::atomic::AtomicBool>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl TurnHandle for MockTurnHandle {
    fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }

    async fn interrupt(&self) -> Result<(), HarnessError> {
        self.interrupt_count.fetch_add(1, Ordering::SeqCst);
        self.release.notify_one();
        if let Some(error) = self.interrupt_error.lock().unwrap().take() {
            return Err(HarnessError::Operation(error));
        }
        Ok(())
    }

    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        if self.hold.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(TurnOutcome {
            status: CompletionStatus::Completed,
            result_text: Some("ok".into()),
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: None,
        })
    }
}

struct TestAdapter {
    adapter: ClaudeSessionRuntime,
    runtime_state: Arc<MockRuntimeState>,
    handle: Arc<MockSessionHandle>,
    provider_configs: Arc<Mutex<Vec<HarnessFactoryConfig>>>,
}

fn test_adapter(session_id: &str) -> TestAdapter {
    let runtime_state = Arc::new(MockRuntimeState::default());
    let handle = Arc::new(MockSessionHandle::new(session_id));
    let provider_configs = Arc::new(Mutex::new(Vec::new()));
    let adapter = ClaudeSessionRuntime::with_runtime_factory({
        let runtime_state = runtime_state.clone();
        let handle = handle.clone();
        let provider_configs = provider_configs.clone();
        move |config, options| {
            provider_configs.lock().unwrap().push(config);
            Ok(vertebrae_harness::HarnessRuntimeInstance {
                provider: Provider::Anthropic,
                runtime: Arc::new(MockRuntime {
                    state: runtime_state.clone(),
                    handle: handle.clone(),
                }),
                request_config: options.request_config,
            })
        }
    });
    TestAdapter {
        adapter,
        runtime_state,
        handle,
        provider_configs,
    }
}

fn input(session_id: &str, initial_prompt: Option<&str>) -> HarnessCreateSessionInput {
    HarnessCreateSessionInput {
        backend_session_id: session_id.into(),
        working_dir: Some("/ignored/by/prepared/session".into()),
        initial_prompt: initial_prompt.map(str::to_owned),
        provider_resume_id: Some("resume-request-1".into()),
        model_id: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        permission_mode: Some(PermissionMode::Plan),
    }
}

fn prepared(model: Option<&str>) -> PreparedSession {
    let mut factory_config = HarnessFactoryConfig::default();
    factory_config
        .environment
        .insert("ADAPTER_TEST".into(), "present".into());
    PreparedSession {
        working_dir: PathBuf::from("/tmp/gui-claude-adapter-test"),
        model: model.map(str::to_owned),
        model_warning: None,
        factory_config,
        plugin_resolution: ClaudePluginDirResolution {
            plugin_root: None,
            warning: None,
        },
        #[cfg(unix)]
        permission_socket: None,
    }
}

fn event(
    sequence: u64,
    semantics: UpdateSemantics,
    payload: HarnessEventPayloadV1,
) -> HarnessEventV1 {
    HarnessEventV1 {
        event_id: EventId::new(format!("event-{sequence}")),
        stream_id: StreamId::new("stream-1"),
        sequence,
        correlation: EventCorrelation {
            parent_tool_call_id: Some(ToolCallId::new("parent-tool")),
            ..EventCorrelation::default()
        },
        timestamp: chrono::Utc::now(),
        semantics,
        provider_sequence: Some(sequence),
        payload,
    }
}

fn root_event(
    backend_session_id: &str,
    sequence: u64,
    semantics: UpdateSemantics,
    payload: HarnessEventPayloadV1,
) -> HarnessEventV1 {
    let mut event = event(sequence, semantics, payload);
    event.stream_id = StreamId::new(format!("local-chat:{backend_session_id}"));
    event.correlation.thread_id = Some(vertebrae_harness_core::ThreadId::new(backend_session_id));
    event.correlation.turn_id = Some(TurnId::new(format!("{backend_session_id}:turn")));
    event
}

fn captured_event_sink(state: &MockRuntimeState) -> Arc<dyn EventSink> {
    state
        .event_sink
        .lock()
        .unwrap()
        .clone()
        .expect("adapter should pass an event sink to the harness")
}

fn captured_events(events: &Arc<Mutex<Vec<LocalChatEvent>>>) -> Vec<LocalChatEvent> {
    events.lock().unwrap().clone()
}

#[test]
fn permission_modes_map_to_harness_values() {
    assert_eq!(
        core_permission_mode(&PermissionMode::Default),
        CorePermissionMode::Default
    );
    assert_eq!(
        core_permission_mode(&PermissionMode::Plan),
        CorePermissionMode::Plan
    );
}

#[test]
fn provider_config_preserves_every_gui_claude_process_setting() {
    let claude_binary = PathBuf::from("/opt/vertebrae/bin/claude");
    let plugin_root = PathBuf::from("/opt/vertebrae/app-data");
    let gate_binary = PathBuf::from("/opt/vertebrae/bin/vtb-gate");
    let permission_socket = PathBuf::from("/tmp/vertebrae-gate/session.sock");
    let locator_root = PathBuf::from("/tmp/claude-project");
    let augmented_path = "/opt/vertebrae/bin:/usr/bin";
    let config = build_factory_config(
        claude_binary.clone(),
        augmented_path,
        &ClaudePluginDirResolution {
            plugin_root: Some(plugin_root.clone()),
            warning: None,
        },
        gate_binary.clone(),
        "backend-config",
        locator_root.clone(),
        Some(&permission_socket),
    );

    assert_eq!(config.anthropic_executable.as_ref(), Some(&claude_binary));
    assert_eq!(
        config.search_path.as_deref(),
        Some(std::ffi::OsStr::new(augmented_path))
    );
    assert_eq!(config.claude_plugin_roots, [plugin_root]);
    assert_eq!(
        config
            .environment
            .get("VTB_CLAUDE_SESSION_ID")
            .map(String::as_str),
        Some("backend-config")
    );
    assert_eq!(
        config
            .environment
            .get("VTB_GATE_SOCKET")
            .map(String::as_str),
        Some(permission_socket.to_string_lossy().as_ref())
    );
    assert_eq!(
        config.claude_permission_prompt_tool.as_deref(),
        Some("mcp__vtb-gate__permission_prompt")
    );
    assert_eq!(
        config.claude_mcp_config,
        Some(serde_json::json!({
            "mcpServers": { "vtb-gate": { "command": gate_binary } }
        }))
    );
    let locator = config
        .claude_root_locator_resolver
        .as_ref()
        .expect("GUI config should resolve Claude transcript locators")
        .resolve(&SessionId::new("provider-session"))
        .unwrap()
        .unwrap();
    assert_eq!(
        locator.as_str(),
        locator_root
            .join("provider-session.jsonl")
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
fn root_locator_uses_claude_project_encoding() {
    let path = claude_project_directory(Path::new("/tmp/My Project"));
    assert!(path.ends_with(".claude/projects/-tmp-My-Project"));
}

#[test]
fn compatibility_value_text_preserves_strings_and_serializes_values() {
    assert_eq!(
        crate::local_chat::harnesses::shared::LocalChatHarnessEventSink::value_text(
            &serde_json::json!("done"),
        ),
        "done"
    );
    assert_eq!(
        crate::local_chat::harnesses::shared::LocalChatHarnessEventSink::value_text(
            &serde_json::json!({"ok": true}),
        ),
        r#"{"ok":true}"#
    );
}

#[tokio::test]
async fn tauri_delivery_failure_is_returned_to_the_harness_event_source() {
    let sink = ClaudeGuiEventSink::new(
        "backend-delivery".into(),
        1,
        LocalChatEventSink::failing_for_tests("window closed"),
        Arc::new(RwLock::new(SessionRegistry::default())),
        None,
        crate::local_chat::permissions::PermissionBridge::new(),
        Arc::new(tokio::sync::Mutex::new(())),
    );

    let error = EventSink::emit(
        &sink,
        event(
            1,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "lost".into(),
            }),
        ),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, HarnessError::EventSink(message) if message == "window closed"));
}

#[tokio::test]
async fn start_request_preserves_identity_resume_working_directory_model_and_reasoning() {
    let test = test_adapter("backend-1");
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

    test.adapter
        .create_prepared_session(input("backend-1", None), runtime, prepared(Some("opus")))
        .await
        .unwrap();

    let requests = test.runtime_state.start_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.session_id.as_str(), "backend-1");
    assert_eq!(request.stream_id.as_str(), "local-chat:backend-1");
    assert_eq!(
        request.resume_id.as_ref().unwrap().as_str(),
        "resume-request-1"
    );
    assert_eq!(
        request.config.working_directory.as_deref(),
        Some(Path::new("/tmp/gui-claude-adapter-test"))
    );
    assert_eq!(request.config.model.as_deref(), Some("opus"));
    assert_eq!(request.config.reasoning_effort.as_deref(), Some("high"));
    assert!(request.config.environment.is_empty());
    drop(requests);
    assert!(test.runtime_state.control_sink.lock().unwrap().is_some());

    let configs = test.provider_configs.lock().unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0]
            .environment
            .get("ADAPTER_TEST")
            .map(String::as_str),
        Some("present")
    );
}

#[tokio::test]
async fn initial_prompt_and_subsequent_messages_use_the_same_session_handle() {
    let test = test_adapter("backend-turns");
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();
    test.adapter
        .create_prepared_session(
            input("backend-turns", Some("initial prompt")),
            runtime,
            prepared(Some("opus")),
        )
        .await
        .unwrap();
    test.adapter
        .send_message("backend-turns", "follow-up")
        .await
        .unwrap();

    let sent = test.handle.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].content, "initial prompt");
    assert_eq!(sent[1].content, "follow-up");
    assert_ne!(sent[0].turn_id, sent[1].turn_id);
    assert!(sent.iter().all(|request| request.output_schema.is_none()));
}

#[tokio::test]
async fn blank_initial_prompt_is_not_sent() {
    let test = test_adapter("backend-blank");
    test.adapter
        .create_prepared_session(
            input("backend-blank", Some(" \n\t")),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();
    assert!(test.handle.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn harness_events_preserve_init_text_tool_usage_terminal_and_diagnostic_semantics() {
    let test = test_adapter("backend-events");
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();
    test.adapter
        .create_prepared_session(
            input("backend-events", None),
            runtime,
            prepared(Some("requested-model")),
        )
        .await
        .unwrap();
    let sink = captured_event_sink(&test.runtime_state);

    sink.emit(event(
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::SessionStarted(SessionStarted {
            provider: "anthropic".into(),
            model: Some("actual-model".into()),
            provider_resume_id: Some(ProviderResumeId::new("provider-resume")),
            tools: vec!["Read".into(), "Bash".into()],
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        2,
        UpdateSemantics::Delta,
        HarnessEventPayloadV1::Text(TextEvent { text: "hel".into() }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        3,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Text(TextEvent {
            text: "hello".into(),
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        4,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
            tool_call_id: ToolCallId::new("tool-1"),
            name: "Bash".into(),
            input: serde_json::json!({"command": "pwd"}),
            status: ToolStatus::Started,
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        41,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
            tool_call_id: ToolCallId::new("question-tool"),
            name: crate::local_chat::permissions::ASK_USER_QUESTION_TOOL.into(),
            input: serde_json::json!({"questions": []}),
            status: ToolStatus::Started,
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        5,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
            tool_call_id: ToolCallId::new("tool-1"),
            output: serde_json::json!({"exit": 1}),
            status: ToolStatus::Failed,
            content_semantics: UpdateSemantics::Snapshot,
        }),
    ))
    .await
    .unwrap();
    let mut usage_event = event(
        6,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Usage(UsageEvent {
            turn_delta: None,
            session_snapshot: Some(SessionUsage {
                tokens: TokenUsage::default(),
                cost_microusd: 0,
                context_tokens: Some(u64::from(u32::MAX) + 100),
                context_window: Some(200_000),
            }),
        }),
    );
    usage_event.stream_id = StreamId::new("local-chat:backend-events");
    usage_event.correlation.parent_tool_call_id = None;
    usage_event.stream_id = StreamId::new("local-chat:backend-events");
    sink.emit(usage_event).await.unwrap();
    let mut agent_usage = event(
        61,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Usage(UsageEvent {
            turn_delta: None,
            session_snapshot: Some(SessionUsage {
                tokens: TokenUsage::default(),
                cost_microusd: 0,
                context_tokens: Some(999),
                context_window: Some(1_000),
            }),
        }),
    );
    agent_usage.stream_id = StreamId::new("local-chat:backend-events/agent/agent-1");
    agent_usage.correlation.parent_tool_call_id = None;
    sink.emit(agent_usage).await.unwrap();
    sink.emit(root_event(
        "backend-events",
        7,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnFinished(TurnOutcome {
            status: CompletionStatus::Completed,
            result_text: Some("finished".into()),
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics {
                duration_ms: Some(4321),
                turn_count: Some(7),
                context_tokens: Some(0),
                context_window: Some(180_000),
                total_cost_usd: Some(0.42),
            },
            error: None,
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        8,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Warning(DiagnosticEvent {
            message: "careful".into(),
            code: None,
        }),
    ))
    .await
    .unwrap();
    sink.emit(event(
        9,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Error(DiagnosticEvent {
            message: "provider error".into(),
            code: Some("provider".into()),
        }),
    ))
    .await
    .unwrap();

    let events = captured_events(&events);
    assert!(!events.iter().any(|event| matches!(event,
        LocalChatEvent::ToolCall(tool)
            if tool.tool_name == crate::local_chat::permissions::ASK_USER_QUESTION_TOOL
    )));
    assert!(matches!(&events[0], LocalChatEvent::Init(init)
        if init.provider_resume_id.as_deref() == Some("provider-resume")
            && init.model == "actual-model"
            && init.tools == ["Read", "Bash"]));
    assert!(matches!(&events[1], LocalChatEvent::Text(text)
        if text.text == "hel" && text.is_partial && text.parent_tool_use_id.as_deref() == Some("parent-tool")));
    assert!(matches!(&events[2], LocalChatEvent::Text(text)
        if text.text == "hello" && !text.is_partial));
    assert!(matches!(&events[3], LocalChatEvent::ToolCall(tool)
        if tool.tool_id == "tool-1" && tool.tool_name == "Bash"
            && tool.input == r#"{"command":"pwd"}"#
            && tool.parent_tool_use_id.as_deref() == Some("parent-tool")));
    assert!(matches!(&events[4], LocalChatEvent::ToolResult(tool)
        if tool.tool_id == "tool-1" && tool.result == r#"{"exit":1}"# && tool.is_error));
    assert!(matches!(&events[5], LocalChatEvent::Usage(usage)
        if usage.model == "actual-model" && usage.context_tokens == u32::MAX
            && usage.context_window == 200_000));
    assert!(matches!(&events[6], LocalChatEvent::End(end)
        if end.result == "finished" && !end.is_error && end.num_turns == 7
            && end.duration_ms == 4321 && end.cost_usd == 0.42
            && end.context_tokens == 0 && end.context_window == 180_000));
    assert!(matches!(&events[7], LocalChatEvent::Warning(warning) if warning.warning == "careful"));
    assert!(matches!(&events[8], LocalChatEvent::Error(error) if error.error == "provider error"));
}

#[tokio::test]
async fn missing_terminal_metadata_uses_legacy_defaults_instead_of_usage_state() {
    let test = test_adapter("backend-terminal-defaults");
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();
    test.adapter
        .create_prepared_session(
            input("backend-terminal-defaults", None),
            runtime,
            prepared(Some("opus")),
        )
        .await
        .unwrap();
    let sink = captured_event_sink(&test.runtime_state);
    let mut usage = event(
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Usage(UsageEvent {
            turn_delta: None,
            session_snapshot: Some(SessionUsage {
                tokens: TokenUsage::default(),
                cost_microusd: 9_000_000,
                context_tokens: Some(123_456),
                context_window: Some(999_999),
            }),
        }),
    );
    usage.stream_id = StreamId::new("local-chat:backend-terminal-defaults");
    sink.emit(usage).await.unwrap();
    sink.emit(root_event(
        "backend-terminal-defaults",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnFinished(TurnOutcome {
            status: CompletionStatus::Completed,
            result_text: None,
            structured_output: None,
            usage: Some(TurnUsage {
                tokens: TokenUsage::default(),
                cost_microusd: 8_000_000,
            }),
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: None,
        }),
    ))
    .await
    .unwrap();

    let events = captured_events(&events);
    assert!(matches!(&events[1], LocalChatEvent::End(end)
        if end.duration_ms == 0 && end.cost_usd == 0.0 && end.num_turns == 0
            && end.context_tokens == 0
            && end.context_window == DEFAULT_CLAUDE_CONTEXT_WINDOW));
}

#[tokio::test]
async fn explicit_close_removes_registry_entry_and_closes_handle_once() {
    let test = test_adapter("backend-close");
    test.adapter
        .create_prepared_session(
            input("backend-close", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();
    assert!(test.adapter.has_session("backend-close").await);

    test.adapter.close_session("backend-close").await.unwrap();

    assert!(!test.adapter.has_session("backend-close").await);
    assert_eq!(test.handle.close_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        test.adapter.send_message("backend-close", "late").await,
        Err(LocalChatSessionError::SessionNotFound(id)) if id == "backend-close"
    ));
}

#[tokio::test]
async fn close_interrupts_the_retained_active_turn_before_closing_session() {
    let test = test_adapter("backend-interrupt");
    test.handle.hold_turns.store(true, Ordering::SeqCst);
    test.adapter
        .create_prepared_session(
            input("backend-interrupt", Some("long turn")),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();

    test.adapter
        .close_session("backend-interrupt")
        .await
        .unwrap();

    assert_eq!(test.handle.interrupt_count.load(Ordering::SeqCst), 1);
    assert_eq!(test.handle.close_count.load(Ordering::SeqCst), 1);
    assert!(!test.adapter.has_session("backend-interrupt").await);
}

#[tokio::test]
async fn interrupt_failure_does_not_skip_session_close() {
    let test = test_adapter("backend-interrupt-failure");
    test.handle.hold_turns.store(true, Ordering::SeqCst);
    *test.handle.interrupt_error.lock().unwrap() = Some("interrupt channel closed".into());
    test.adapter
        .create_prepared_session(
            input("backend-interrupt-failure", Some("long turn")),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();

    test.adapter
        .close_session("backend-interrupt-failure")
        .await
        .unwrap();

    assert_eq!(test.handle.interrupt_count.load(Ordering::SeqCst), 1);
    assert_eq!(test.handle.close_count.load(Ordering::SeqCst), 1);
    assert!(!test.adapter.has_session("backend-interrupt-failure").await);
}

#[tokio::test]
async fn session_closed_during_start_is_never_inserted_into_the_registry() {
    let test = test_adapter("backend-start-close-race");
    test.runtime_state
        .close_during_start
        .store(true, Ordering::SeqCst);
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    let error = test
        .adapter
        .create_prepared_session(
            input("backend-start-close-race", None),
            runtime,
            prepared(None),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, LocalChatSessionError::StartFailed(message)
        if message.contains("ended during initialization")));
    assert!(!test.adapter.has_session("backend-start-close-race").await);
    test.runtime_state
        .close_during_start
        .store(false, Ordering::SeqCst);
    test.adapter
        .create_prepared_session(
            input("backend-start-close-race", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .expect("startup close must release its reservation after dropping the socket guard");
    assert!(
        matches!(captured_events(&events).as_slice(), [LocalChatEvent::Error(error)]
        if error.error == "exited during startup")
    );
}

#[tokio::test]
async fn startup_error_after_session_closed_releases_the_closing_reservation() {
    let test = test_adapter("backend-start-close-error-race");
    test.runtime_state
        .close_during_start
        .store(true, Ordering::SeqCst);
    *test.runtime_state.close_then_start_error.lock().unwrap() =
        Some("startup reported failure after process exit".into());

    let error = test
        .adapter
        .create_prepared_session(
            input("backend-start-close-error-race", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, LocalChatSessionError::StartFailed(message)
        if message.contains("startup reported failure after process exit")));
    test.runtime_state
        .close_during_start
        .store(false, Ordering::SeqCst);
    test.adapter
        .create_prepared_session(
            input("backend-start-close-error-race", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .expect("the startup error must clear the closing reservation");
}

#[tokio::test]
async fn process_loss_event_removes_registry_and_emits_error() {
    let test = test_adapter("backend-lost");
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();
    test.adapter
        .create_prepared_session(input("backend-lost", None), runtime, prepared(None))
        .await
        .unwrap();
    captured_event_sink(&test.runtime_state)
        .emit(event(
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::SessionClosed(SessionCloseOutcome {
                status: SessionCloseStatus::ProcessLost,
                error: Some("claude exited".into()),
            }),
        ))
        .await
        .unwrap();

    assert!(!test.adapter.has_session("backend-lost").await);
    assert!(
        matches!(captured_events(&events).as_slice(), [LocalChatEvent::Error(error)]
        if error.error == "claude exited")
    );
}

#[tokio::test]
async fn session_closed_racing_registry_insertion_cannot_leave_a_dead_handle() {
    let mut test = test_adapter("backend-race");
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    test.adapter.registry_insert_hook = Some(RegistryInsertHook {
        reached: reached.clone(),
        release: release.clone(),
    });
    let adapter = test.adapter.clone();
    let create = tokio::spawn(async move {
        adapter
            .create_prepared_session(
                input("backend-race", None),
                LocalChatRuntime::inert_for_tests(),
                prepared(None),
            )
            .await
    });
    reached.notified().await;
    let sink = captured_event_sink(&test.runtime_state);
    let closed = tokio::spawn(async move {
        sink.emit(event(
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::SessionClosed(SessionCloseOutcome {
                status: SessionCloseStatus::Closed,
                error: None,
            }),
        ))
        .await
    });
    tokio::task::yield_now().await;
    release.notify_one();

    create.await.unwrap().unwrap();
    closed.await.unwrap().unwrap();
    assert!(!test.adapter.has_session("backend-race").await);
}

#[tokio::test]
async fn concurrent_creates_reserve_the_backend_id_before_startup() {
    let mut test = test_adapter("backend-duplicate");
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    test.adapter.registry_insert_hook = Some(RegistryInsertHook {
        reached: reached.clone(),
        release: release.clone(),
    });
    let adapter = test.adapter.clone();
    let first = tokio::spawn(async move {
        adapter
            .create_prepared_session(
                input("backend-duplicate", None),
                LocalChatRuntime::inert_for_tests(),
                prepared(None),
            )
            .await
    });
    reached.notified().await;

    let duplicate = test
        .adapter
        .create_prepared_session(
            input("backend-duplicate", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await;
    assert_eq!(
        duplicate,
        Err(LocalChatSessionError::SessionExists(
            "backend-duplicate".into()
        ))
    );
    assert_eq!(test.runtime_state.start_requests.lock().unwrap().len(), 1);

    release.notify_one();
    first.await.unwrap().unwrap();
    assert!(test.adapter.has_session("backend-duplicate").await);
}

#[tokio::test]
async fn cancelled_startup_releases_its_backend_id_reservation() {
    let mut test = test_adapter("backend-cancelled-startup");
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    test.adapter.registry_insert_hook = Some(RegistryInsertHook {
        reached: reached.clone(),
        release,
    });
    let adapter = test.adapter.clone();
    let create = tokio::spawn(async move {
        adapter
            .create_prepared_session(
                input("backend-cancelled-startup", None),
                LocalChatRuntime::inert_for_tests(),
                prepared(None),
            )
            .await
    });
    reached.notified().await;
    create.abort();
    let _ = create.await;
    test.adapter.registry_insert_hook = None;

    for _ in 0..100 {
        match test
            .adapter
            .create_prepared_session(
                input("backend-cancelled-startup", None),
                LocalChatRuntime::inert_for_tests(),
                prepared(None),
            )
            .await
        {
            Ok(()) => return,
            Err(LocalChatSessionError::SessionExists(_)) => tokio::task::yield_now().await,
            Err(error) => panic!("cancelled startup should release its reservation: {error}"),
        }
    }
    panic!("cancelled startup kept its reservation");
}

#[tokio::test]
async fn stale_session_closed_event_cannot_remove_a_replacement_generation() {
    let test = test_adapter("backend-replacement");
    test.adapter
        .create_prepared_session(
            input("backend-replacement", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();
    let stale_sink = captured_event_sink(&test.runtime_state);
    test.adapter
        .close_session("backend-replacement")
        .await
        .unwrap();

    test.adapter
        .create_prepared_session(
            input("backend-replacement", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();
    stale_sink
        .emit(event(
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::SessionClosed(SessionCloseOutcome {
                status: SessionCloseStatus::Closed,
                error: None,
            }),
        ))
        .await
        .unwrap();

    assert!(test.adapter.has_session("backend-replacement").await);
}

#[tokio::test]
async fn close_keeps_the_backend_id_reserved_until_the_old_handle_and_socket_drop() {
    let test = test_adapter("backend-closing");
    test.handle.hold_close.store(true, Ordering::SeqCst);
    test.adapter
        .create_prepared_session(
            input("backend-closing", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();

    let adapter = test.adapter.clone();
    let closing = tokio::spawn(async move { adapter.close_session("backend-closing").await });
    while test.handle.close_count.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }

    let duplicate = test
        .adapter
        .create_prepared_session(
            input("backend-closing", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await;
    assert_eq!(
        duplicate,
        Err(LocalChatSessionError::SessionExists(
            "backend-closing".into()
        ))
    );

    test.handle.close_release.notify_one();
    closing.await.unwrap().unwrap();
    test.adapter
        .create_prepared_session(
            input("backend-closing", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn cancelled_close_eventually_releases_its_backend_id_reservation() {
    let test = test_adapter("backend-cancelled-close");
    test.handle.hold_close.store(true, Ordering::SeqCst);
    test.adapter
        .create_prepared_session(
            input("backend-cancelled-close", None),
            LocalChatRuntime::inert_for_tests(),
            prepared(None),
        )
        .await
        .unwrap();

    let adapter = test.adapter.clone();
    let closing =
        tokio::spawn(async move { adapter.close_session("backend-cancelled-close").await });
    while test.handle.close_count.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    closing.abort();
    let _ = closing.await;
    test.handle.hold_close.store(false, Ordering::SeqCst);
    test.handle.close_release.notify_one();

    for _ in 0..100 {
        match test
            .adapter
            .create_prepared_session(
                input("backend-cancelled-close", None),
                LocalChatRuntime::inert_for_tests(),
                prepared(None),
            )
            .await
        {
            Ok(()) => return,
            Err(LocalChatSessionError::SessionExists(_)) => tokio::task::yield_now().await,
            Err(error) => panic!("cancelled close should release its reservation: {error}"),
        }
    }
    panic!("cancelled close kept its reservation");
}

#[tokio::test]
async fn explicit_close_denies_pending_harness_controls() {
    let test = test_adapter("backend-pending-control");
    let runtime = LocalChatRuntime::inert_for_tests();
    let permission_bridge = runtime.permission_bridge();
    test.adapter
        .create_prepared_session(
            input("backend-pending-control", None),
            runtime.clone(),
            prepared(None),
        )
        .await
        .unwrap();

    let control = ControlRequestEnvelope {
        request_id: vertebrae_harness_core::ControlRequestId::new("pending-close-control"),
        session_id: None,
        turn_id: None,
        thread_id: None,
        is_root: None,
        request: ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::CommandExecution,
            title: "Run command".into(),
            details: None,
            modification_supported: false,
        }),
        presentation: None,
        timeout_ms: None,
        automatic_resolution: None,
    };
    let pending =
        permission_bridge.queue_harness_control_for_tests("backend-pending-control", control);
    assert_eq!(
        permission_bridge.pending_harness_control_count_for_session("backend-pending-control"),
        1
    );

    test.adapter
        .close_session("backend-pending-control")
        .await
        .unwrap();
    assert_eq!(pending.await.unwrap().behavior, "deny");
}

#[tokio::test]
async fn initial_send_failure_cleans_registry_closes_handle_and_reports_error() {
    let test = test_adapter("backend-send-failure");
    *test.handle.send_error.lock().unwrap() = Some("stdin closed".into());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();
    let error = test
        .adapter
        .create_prepared_session(
            input("backend-send-failure", Some("first")),
            runtime,
            prepared(None),
        )
        .await
        .unwrap_err();

    assert!(
        matches!(error, LocalChatSessionError::SendFailed(message) if message.contains("stdin closed"))
    );
    assert!(!test.adapter.has_session("backend-send-failure").await);
    assert_eq!(test.handle.close_count.load(Ordering::SeqCst), 1);
    assert!(
        matches!(captured_events(&events).as_slice(), [LocalChatEvent::Error(error)]
        if error.error.contains("stdin closed"))
    );
}

#[tokio::test]
async fn start_failure_is_mapped_and_emitted_without_registering_session() {
    let test = test_adapter("backend-start-failure");
    *test.runtime_state.start_error.lock().unwrap() = Some("bad launch".into());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();
    let error = test
        .adapter
        .create_prepared_session(
            input("backend-start-failure", None),
            runtime,
            prepared(None),
        )
        .await
        .unwrap_err();

    assert!(
        matches!(error, LocalChatSessionError::StartFailed(message) if message.contains("bad launch"))
    );
    assert!(!test.adapter.has_session("backend-start-failure").await);
    assert!(
        matches!(captured_events(&events).as_slice(), [LocalChatEvent::Error(error)]
        if error.error.contains("bad launch"))
    );
}

#[test]
fn production_gui_claude_adapter_has_no_process_launch_or_stream_json_parser() {
    let production_sources = [
        ("claude/mod.rs", include_str!("../mod.rs")),
        ("claude/args.rs", include_str!("../args.rs")),
        ("claude/session/mod.rs", include_str!("mod.rs")),
    ];
    for (name, source) in production_sources {
        assert!(
            !source.contains("Command::new"),
            "{name} launches a process directly"
        );
        assert!(
            !source.contains("tokio::process"),
            "{name} owns process plumbing"
        );
        assert!(
            !source.contains("serde_json::from_str"),
            "{name} deserializes provider stream-json"
        );
        assert!(
            !source.contains("StreamDeserializer"),
            "{name} contains a provider stream parser"
        );
    }
}
