#![cfg(unix)]

//! Cross-surface contract tests. The persistent mode is the GUI consumption
//! shape and the one-shot mode is the daemon consumption shape. The allowlist
//! below is intentionally the complete set of packaging-only differences.

use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{Value, json};
use tempfile::TempDir;
use vertebrae_harness_claude::{
    ClaudeLaunchMode, ClaudePermissionMode, ClaudeProviderConfig, ClaudeProviderPrelude,
    ClaudeRuntime,
};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequestEnvelope, ControlResolution, ControlSink,
    EventId, EventSink, FileChange, FileChangeEvent, FileChangeKind, HarnessError,
    HarnessEventPayloadV1, HarnessEventV1, HarnessProjection, HarnessRuntime, ProviderResumeId,
    ProviderThreadRef, RequestConfig, ResolutionSource, RunId, RunRequest, SendTurnRequest,
    SessionId, StartSessionRequest, StreamId, ToolCallId, ToolStatus, TurnId, TurnInputProvenance,
    UpdateSemantics,
};

/// These events differ because one surface owns a reusable session while the
/// other owns a single run. Their semantic contents are normalized and still
/// compared; no provider content event is allowlisted.
const LIFECYCLE_PACKAGING_ALLOWLIST: &[&str] = &[
    "session_started",
    "turn_started",
    "turn_finished",
    "session_closed",
    "run_finished",
];

#[derive(Default)]
struct CollectSink(Mutex<Vec<HarnessEventV1>>);

#[async_trait]
impl EventSink for CollectSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}

#[derive(Clone)]
struct FixedControl {
    source: ResolutionSource,
    decision: ControlDecision,
}

#[async_trait]
impl ControlSink for FixedControl {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Ok(ControlResolution {
            request_id: request.request_id,
            source: self.source,
            decision: Some(self.decision.clone()),
            message: None,
        })
    }
}

struct FailingControl;

#[async_trait]
impl ControlSink for FailingControl {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Err(HarnessError::Control("parity fixture rejection".into()))
    }
}

struct ScenarioResult {
    events: Vec<HarnessEventV1>,
    terminal: Value,
}

#[tokio::test]
async fn gui_persistent_and_daemon_one_shot_share_the_full_success_projection() {
    for (name, resume_id, source, decision) in [
        (
            "new-allow",
            None,
            ResolutionSource::Consumer,
            ControlDecision::AllowOnce,
        ),
        (
            "resumed-deny",
            Some("parity-session"),
            ResolutionSource::Consumer,
            ControlDecision::Deny,
        ),
        (
            "new-timeout",
            None,
            ResolutionSource::Timeout,
            ControlDecision::Deny,
        ),
    ] {
        let temp = TempDir::new().unwrap();
        let executable = success_script(&temp);
        let control = Arc::new(FixedControl { source, decision });
        let persistent = run_persistent(&executable, resume_id, control.clone()).await;
        let one_shot = run_one_shot(&executable, control).await;

        assert_json_roundtrip(&persistent.events);
        assert_json_roundtrip(&one_shot.events);
        assert_only_lifecycle_is_surface_specific(&persistent.events, &one_shot.events);
        assert_eq!(
            semantic_projection(&persistent.events, &persistent.terminal),
            semantic_projection(&one_shot.events, &one_shot.terminal),
            "semantic drift in scenario {name}"
        );
    }
}

#[tokio::test]
async fn provider_failure_process_loss_and_malformed_records_have_parity() {
    for (name, body) in [
        (
            "provider-failure",
            scenario_script(
                r#"printf '%s\n' '{"type":"result","subtype":"error","result":"provider exploded"}'"#,
            ),
        ),
        ("process-loss", scenario_script("exit 9")),
        (
            "malformed",
            scenario_script(
                r#"printf '%s\n' '{"type":"assistant","message":{"content":"wrong"}}'"#,
            ),
        ),
    ] {
        let temp = TempDir::new().unwrap();
        let executable = script(&temp, name, &body);
        let control = Arc::new(FixedControl {
            source: ResolutionSource::Consumer,
            decision: ControlDecision::AllowOnce,
        });
        let persistent = run_persistent(&executable, None, control.clone()).await;
        let one_shot = run_one_shot(&executable, control).await;
        assert_eq!(persistent.terminal["status"], "failed", "{name}");
        assert_eq!(one_shot.terminal["status"], "failed", "{name}");

        let persistent_projection = semantic_projection(&persistent.events, &persistent.terminal);
        let one_shot_projection = semantic_projection(&one_shot.events, &one_shot.terminal);
        assert_eq!(
            persistent_projection, one_shot_projection,
            "full failure projection drift in {name}"
        );
    }
}

#[tokio::test]
async fn active_turn_control_failure_is_a_failed_turn_with_fallback_resolution() {
    let temp = TempDir::new().unwrap();
    let executable = control_wait_script(&temp);
    let persistent = run_persistent(&executable, None, Arc::new(FailingControl)).await;
    let one_shot = run_one_shot(&executable, Arc::new(FailingControl)).await;

    for result in [&persistent, &one_shot] {
        assert_eq!(result.terminal["status"], "failed");
        assert!(result.events.iter().any(|event| matches!(
            &event.payload,
            HarnessEventPayloadV1::ControlResolved(resolution)
                if resolution.source == ResolutionSource::Fallback
        )));
    }
    assert!(persistent.events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::TurnFinished(outcome)
            if outcome.status == CompletionStatus::Failed
    )));
    assert!(one_shot.events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::RunFinished(outcome)
            if outcome.status == CompletionStatus::Failed
    )));
    assert_eq!(
        semantic_projection(&persistent.events, &persistent.terminal),
        semantic_projection(&one_shot.events, &one_shot.terminal),
        "control failures must retain full semantic parity"
    );
}

#[tokio::test]
async fn interruption_and_cancellation_keep_their_distinct_lifecycle_contract() {
    let temp = TempDir::new().unwrap();
    let executable = hanging_script(&temp);
    let control = Arc::new(FixedControl {
        source: ResolutionSource::Consumer,
        decision: ControlDecision::AllowOnce,
    });

    let runtime = runtime(&executable);
    let persistent_sink = Arc::new(CollectSink::default());
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("placeholder"),
                stream_id: StreamId::from("persistent-stream"),
                resume_id: None,
                config: RequestConfig {
                    output_schema: Some(json!({"type": "object"})),
                    ..RequestConfig::default()
                },
            },
            persistent_sink.clone(),
            control.clone(),
        )
        .await
        .unwrap();
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("parity-turn"),
            content: "exact prompt".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    turn.interrupt().await.unwrap();
    assert_eq!(
        turn.await_outcome().await.unwrap().status,
        CompletionStatus::Interrupted
    );

    let one_shot_sink = Arc::new(CollectSink::default());
    let run = runtime
        .run_once(
            RunRequest {
                run_id: RunId::from("parity-run"),
                stream_id: StreamId::from("one-shot-stream"),
                prompt: "exact prompt".into(),
                config: RequestConfig::default(),
            },
            one_shot_sink.clone(),
            control,
        )
        .await
        .unwrap();
    wait_for_payload(&one_shot_sink, |payload| {
        matches!(payload, HarnessEventPayloadV1::TurnInput(_))
    })
    .await;
    run.cancel().await.unwrap();
    assert_eq!(
        run.await_outcome().await.unwrap().status,
        CompletionStatus::Cancelled
    );

    assert!(
        persistent_sink
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(
                &event.payload,
                HarnessEventPayloadV1::TurnFinished(outcome)
                    if outcome.status == CompletionStatus::Interrupted
            ))
    );
    assert!(one_shot_sink.0.lock().unwrap().iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::RunFinished(outcome)
            if outcome.status == CompletionStatus::Cancelled
    )));

    let persistent_events = persistent_sink.0.lock().unwrap().clone();
    let one_shot_events = one_shot_sink.0.lock().unwrap().clone();
    assert_eq!(
        common_pre_terminal_semantics(&persistent_events),
        common_pre_terminal_semantics(&one_shot_events),
        "interrupt and cancel must share init, root declaration, exact input, and pre-terminal projection"
    );
}

async fn wait_for_payload(
    sink: &Arc<CollectSink>,
    predicate: impl Fn(&HarnessEventPayloadV1) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if sink
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|event| predicate(&event.payload))
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected pre-terminal harness event");
}

fn common_pre_terminal_semantics(events: &[HarnessEventV1]) -> Value {
    let init = events
        .iter()
        .find_map(|event| match &event.payload {
            HarnessEventPayloadV1::SessionStarted(started) => Some(json!({
                "provider": started.provider,
                "model": started.model,
                "tools": started.tools,
            })),
            _ => None,
        })
        .expect("scenario must contain Claude init metadata");
    json!({
        "init": init,
        // The placeholder removes only the deliberately distinct terminal
        // Interrupted-vs-Cancelled wrapper. `semantic_projection` still checks
        // the normalized raw trace, full ThreadDeclared identity/locator, exact
        // TurnInput content/provenance, and all reduced pre-terminal state.
        "projection": semantic_projection(events, &json!({"terminal": "surface-owned"})),
    })
}

#[test]
fn gui_persistent_and_daemon_one_shot_own_distinct_exact_launch_policies() {
    let temp = TempDir::new().unwrap();
    let executable = script(&temp, "noop", "#!/bin/sh\nexit 0\n");
    let gui_plugin = temp.path().join("gui-plugin");
    let gui_provider_owned = ClaudeProviderConfig {
        executable: Some(executable.clone()),
        search_path: Some("/gui/bin".into()),
        environment: BTreeMap::from([("VTB_CLAUDE_SESSION_ID".into(), "gui-session".into())]),
        plugin_roots: vec![gui_plugin.clone()],
        permission_mode: Some(ClaudePermissionMode::Plan),
        permission_prompt_tool: Some("mcp__vtb-gate__permission_prompt".into()),
        mcp_config: Some(json!({
            "mcpServers": {"vtb-gate": {"command": "gate"}}
        })),
        ..ClaudeProviderConfig::default()
    };
    let gui_request_owned = RequestConfig {
        working_directory: Some(temp.path().to_path_buf()),
        model: Some("sonnet".into()),
        output_schema: Some(json!({"type": "object"})),
        environment: BTreeMap::from([("REQUEST_SCOPE".into(), "gui".into())]),
        ..RequestConfig::default()
    };

    let gui_new = gui_provider_owned
        .command_spec(
            ClaudeLaunchMode::Persistent { resume_id: None },
            &gui_request_owned,
        )
        .unwrap();
    let gui_resumed = gui_provider_owned
        .command_spec(
            ClaudeLaunchMode::Persistent {
                resume_id: Some("resume-exact"),
            },
            &gui_request_owned,
        )
        .unwrap();
    assert_eq!(gui_new.program, executable);
    assert_eq!(gui_new.current_dir.as_deref(), Some(temp.path()));
    assert_eq!(gui_new.environment["PATH"], "/gui/bin");
    assert_eq!(gui_new.environment["VTB_CLAUDE_SESSION_ID"], "gui-session");
    assert_eq!(gui_new.environment["REQUEST_SCOPE"], "gui");
    assert_eq!(
        gui_new.args,
        vec![
            "--print",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--mcp-config",
            "{\"mcpServers\":{\"vtb-gate\":{\"command\":\"gate\"}}}",
            "--permission-prompt-tool",
            "mcp__vtb-gate__permission_prompt",
            "--plugin-dir",
            gui_plugin.to_str().unwrap(),
            "--model",
            "sonnet",
            "--permission-mode",
            "plan",
            "--json-schema",
            "{\"type\":\"object\"}",
        ]
    );
    let mut expected_resumed = gui_new.args.clone();
    expected_resumed.push("--resume=resume-exact".into());
    assert_eq!(gui_resumed.args, expected_resumed);

    let settings = temp.path().join("daemon-settings.json");
    let daemon_plugin = temp.path().join("daemon-plugin");
    let daemon_agent = temp.path().join("reviewer.md");
    let daemon_provider_owned = ClaudeProviderConfig {
        executable: Some(executable),
        search_path: Some("/daemon/bin".into()),
        prelude: ClaudeProviderPrelude {
            settings_path: Some(settings.clone()),
            settings_json: None,
            args: vec!["--system-prompt".into(), "daemon-policy".into()],
        },
        plugin_roots: vec![daemon_plugin.clone()],
        agent_paths: vec![daemon_agent.clone()],
        permission_mode: Some(ClaudePermissionMode::DontAsk),
        ..ClaudeProviderConfig::default()
    };
    let daemon_request_owned = RequestConfig {
        working_directory: Some(temp.path().to_path_buf()),
        model: Some("opus".into()),
        output_schema: Some(json!({"type": "object"})),
        environment: BTreeMap::from([("REQUEST_SCOPE".into(), "daemon".into())]),
        ..RequestConfig::default()
    };
    let daemon_one_shot = daemon_provider_owned
        .command_spec(
            ClaudeLaunchMode::OneShot {
                prompt: "exact prompt",
            },
            &daemon_request_owned,
        )
        .unwrap();
    assert_eq!(daemon_one_shot.current_dir.as_deref(), Some(temp.path()));
    assert_eq!(daemon_one_shot.environment["PATH"], "/daemon/bin");
    assert_eq!(daemon_one_shot.environment["REQUEST_SCOPE"], "daemon");
    assert_eq!(
        daemon_one_shot.args,
        vec![
            "--settings",
            settings.to_str().unwrap(),
            "--system-prompt",
            "daemon-policy",
            "--plugin-dir",
            daemon_plugin.to_str().unwrap(),
            "--agent",
            daemon_agent.to_str().unwrap(),
            "--model",
            "opus",
            "--permission-mode",
            "dontAsk",
            "--json-schema",
            "{\"type\":\"object\"}",
            "--print",
            "exact prompt",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
    );
}

#[tokio::test]
async fn semantic_comparison_detects_mutation() {
    let temp = TempDir::new().unwrap();
    let executable = success_script(&temp);
    let result = run_one_shot(
        &executable,
        Arc::new(FixedControl {
            source: ResolutionSource::Consumer,
            decision: ControlDecision::AllowOnce,
        }),
    )
    .await;
    let baseline = semantic_projection(&result.events, &result.terminal);

    let text_delta_index = result
        .events
        .iter()
        .position(|event| {
            matches!(event.payload, HarnessEventPayloadV1::Text(_))
                && event.semantics == UpdateSemantics::Delta
        })
        .unwrap();
    let mut dropped_delta = result.events.clone();
    dropped_delta.remove(text_delta_index);
    assert_event_mutation_detected(
        &baseline,
        resequence(dropped_delta),
        result.terminal.clone(),
        "dropped delta",
    );

    let mut duplicated_delta = result.events.clone();
    let mut duplicate = duplicated_delta[text_delta_index].clone();
    duplicate.event_id = EventId::from("mutation-duplicated-delta");
    duplicated_delta.insert(text_delta_index + 1, duplicate);
    assert_event_mutation_detected(
        &baseline,
        resequence(duplicated_delta),
        result.terminal.clone(),
        "duplicated delta",
    );

    let mut wrong_text_semantics = result.events.clone();
    wrong_text_semantics[text_delta_index].semantics = UpdateSemantics::Snapshot;
    assert_event_mutation_detected(
        &baseline,
        wrong_text_semantics,
        result.terminal.clone(),
        "text update semantics hidden by later snapshot",
    );

    let mut wrong_authorship = result.events.clone();
    let input = wrong_authorship
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::TurnInput(input)
                if input.provenance == TurnInputProvenance::Agent =>
            {
                Some(input)
            }
            _ => None,
        })
        .unwrap();
    input.provenance = TurnInputProvenance::Human;
    assert_event_mutation_detected(
        &baseline,
        wrong_authorship,
        result.terminal.clone(),
        "delegated input authorship",
    );

    let mut flattened_lineage = result.events.clone();
    let child = flattened_lineage
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::ThreadDeclared(declaration)
                if declaration.thread_id.as_str() == "child-agent" =>
            {
                Some(declaration)
            }
            _ => None,
        })
        .unwrap();
    child.parent_thread_id = None;
    assert_event_mutation_detected(
        &baseline,
        flattened_lineage,
        result.terminal.clone(),
        "flattened child lineage",
    );

    let mut wrong_provider_locator = result.events.clone();
    let declaration = wrong_provider_locator
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::ThreadDeclared(declaration)
                if declaration.thread_id.as_str() == "child-agent" =>
            {
                Some(declaration)
            }
            _ => None,
        })
        .unwrap();
    declaration.provider_thread_ref = Some(ProviderThreadRef::from("wrong://child.jsonl"));
    assert_event_mutation_detected(
        &baseline,
        wrong_provider_locator,
        result.terminal.clone(),
        "provider thread locator",
    );

    let mut flattened_stream = result.events.clone();
    for event in &mut flattened_stream {
        if event.correlation.thread_id.as_ref().map(|id| id.as_str()) == Some("child-agent") {
            event.stream_id = StreamId::from("one-shot-stream");
        }
    }
    assert_event_mutation_detected(
        &baseline,
        resequence(flattened_stream),
        result.terminal.clone(),
        "flattened child stream",
    );

    let mut wrong_tool = result.events.clone();
    let tool = wrong_tool
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::ToolCall(call) if call.tool_call_id.as_str() == "bash-ok" => {
                Some(call)
            }
            _ => None,
        })
        .unwrap();
    tool.tool_call_id = "mutated-tool-id".into();
    tool.status = ToolStatus::Failed;
    assert_event_mutation_detected(
        &baseline,
        wrong_tool,
        result.terminal.clone(),
        "tool id/status",
    );

    let mut wrong_usage = result.events.clone();
    let usage = wrong_usage
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::Usage(usage) => usage.turn_delta.as_mut(),
            _ => None,
        })
        .unwrap();
    usage.tokens.input_tokens += 1;
    assert_event_mutation_detected(&baseline, wrong_usage, result.terminal.clone(), "usage");

    assert_eq!(
        baseline["threads"]["parity-session"]["turn_usage"]["tokens"]["input_tokens"],
        10
    );
    assert_eq!(result.terminal["usage"]["tokens"]["input_tokens"], 10);
    let mut double_counted_terminal_usage = result.events.clone();
    let usage_index = double_counted_terminal_usage
        .iter()
        .rposition(|event| matches!(event.payload, HarnessEventPayloadV1::Usage(_)))
        .unwrap();
    let mut duplicated_usage = double_counted_terminal_usage[usage_index].clone();
    duplicated_usage.event_id = EventId::from("mutation-terminal-usage-double-count");
    double_counted_terminal_usage.insert(usage_index + 1, duplicated_usage);
    assert_event_mutation_detected(
        &baseline,
        resequence(double_counted_terminal_usage),
        result.terminal.clone(),
        "terminal informational usage double count",
    );

    let mut wrong_file_change = result.events.clone();
    let change = wrong_file_change
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::FileChange(changes) => changes.changes.first_mut(),
            _ => None,
        })
        .unwrap();
    change.path = "src/wrong.rs".into();
    change.kind = FileChangeKind::Deleted;
    assert_event_mutation_detected(
        &baseline,
        wrong_file_change,
        result.terminal.clone(),
        "file change path/kind",
    );

    let mut wrong_control = result.events.clone();
    let resolution = wrong_control
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::ControlResolved(resolution) => Some(resolution),
            _ => None,
        })
        .unwrap();
    resolution.decision = Some(ControlDecision::Deny);
    assert_event_mutation_detected(
        &baseline,
        wrong_control,
        result.terminal.clone(),
        "control resolution",
    );

    let mut wrong_structured = result.events.clone();
    let mut structured_terminal = result.terminal.clone();
    structured_terminal["structured_output"] = json!({"ok": false});
    let outcome = wrong_structured
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::RunFinished(outcome) => Some(outcome),
            _ => None,
        })
        .unwrap();
    outcome.structured_output = Some(json!({"ok": false}));
    assert_event_mutation_detected(
        &baseline,
        wrong_structured,
        structured_terminal,
        "structured output",
    );

    let mut wrong_status = result.events.clone();
    let mut status_terminal = result.terminal.clone();
    status_terminal["status"] = json!("failed");
    let outcome = wrong_status
        .iter_mut()
        .find_map(|event| match &mut event.payload {
            HarnessEventPayloadV1::RunFinished(outcome) => Some(outcome),
            _ => None,
        })
        .unwrap();
    outcome.status = CompletionStatus::Failed;
    assert_event_mutation_detected(&baseline, wrong_status, status_terminal, "terminal status");
}

fn assert_event_mutation_detected(
    baseline: &Value,
    events: Vec<HarnessEventV1>,
    terminal: Value,
    mutation: &str,
) {
    assert_ne!(
        baseline,
        &semantic_projection(&events, &terminal),
        "parity oracle missed {mutation}"
    );
}

fn resequence(mut events: Vec<HarnessEventV1>) -> Vec<HarnessEventV1> {
    let mut sequences = std::collections::BTreeMap::<StreamId, u64>::new();
    for event in &mut events {
        let sequence = sequences.entry(event.stream_id.clone()).or_default();
        *sequence += 1;
        event.sequence = *sequence;
    }
    events
}

async fn run_persistent(
    executable: &Path,
    resume_id: Option<&str>,
    controls: Arc<dyn ControlSink>,
) -> ScenarioResult {
    let sink = Arc::new(CollectSink::default());
    let session = runtime(executable)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("placeholder"),
                stream_id: StreamId::from("persistent-stream"),
                resume_id: resume_id.map(ProviderResumeId::from),
                config: RequestConfig {
                    output_schema: Some(json!({"type": "object"})),
                    ..RequestConfig::default()
                },
            },
            sink.clone(),
            controls,
        )
        .await
        .unwrap();
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("parity-turn"),
            content: "exact prompt".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(3), turn.await_outcome())
        .await
        .unwrap()
        .unwrap();
    let _ = session.close().await;
    let mut events = sink.0.lock().unwrap().clone();
    inject_consumer_file_change_fixture(&mut events);
    ScenarioResult {
        events,
        terminal: serde_json::to_value(outcome).unwrap(),
    }
}

async fn run_one_shot(executable: &Path, controls: Arc<dyn ControlSink>) -> ScenarioResult {
    let sink = Arc::new(CollectSink::default());
    let run = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("parity-run"),
                stream_id: StreamId::from("one-shot-stream"),
                prompt: "exact prompt".into(),
                config: RequestConfig {
                    output_schema: Some(json!({"type": "object"})),
                    ..RequestConfig::default()
                },
            },
            sink.clone(),
            controls,
        )
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(3), run.await_outcome())
        .await
        .unwrap()
        .unwrap();
    let mut events = sink.0.lock().unwrap().clone();
    inject_consumer_file_change_fixture(&mut events);
    ScenarioResult {
        events,
        terminal: serde_json::to_value(outcome).unwrap(),
    }
}

fn inject_consumer_file_change_fixture(events: &mut Vec<HarnessEventV1>) {
    let mut event = events
        .iter()
        .rev()
        .find(|event| {
            event.correlation.thread_id.as_ref().map(|id| id.as_str()) == Some("parity-session")
        })
        .unwrap()
        .clone();
    event.event_id = EventId::from("consumer-file-change-fixture");
    event.sequence = events
        .iter()
        .filter(|candidate| candidate.stream_id == event.stream_id)
        .map(|candidate| candidate.sequence)
        .max()
        .unwrap_or_default()
        + 1;
    event.semantics = UpdateSemantics::Delta;
    event.provider_sequence = None;
    event.payload = HarnessEventPayloadV1::FileChange(FileChangeEvent {
        tool_call_id: Some(ToolCallId::from("consumer-file-change")),
        changes: vec![FileChange {
            path: "src/parity.rs".into(),
            kind: FileChangeKind::Modified,
            previous_path: None,
            patch: Some("@@ parity @@".into()),
        }],
        status: ToolStatus::Completed,
    });
    events.push(event);
}

fn assert_json_roundtrip(events: &[HarnessEventV1]) {
    for event in events {
        let encoded = serde_json::to_value(event).unwrap();
        let decoded: HarnessEventV1 = serde_json::from_value(encoded).unwrap();
        assert_eq!(&decoded, event);
    }
}

fn assert_only_lifecycle_is_surface_specific(
    persistent: &[HarnessEventV1],
    one_shot: &[HarnessEventV1],
) {
    let persistent_lifecycle = persistent
        .iter()
        .filter(|event| LIFECYCLE_PACKAGING_ALLOWLIST.contains(&event.payload.event_type()))
        .count();
    let one_shot_lifecycle = one_shot
        .iter()
        .filter(|event| LIFECYCLE_PACKAGING_ALLOWLIST.contains(&event.payload.event_type()))
        .count();
    assert!(persistent_lifecycle > 0 && one_shot_lifecycle > 0);
    for event in persistent.iter().chain(one_shot) {
        if matches!(
            event.payload,
            HarnessEventPayloadV1::SessionStarted(_)
                | HarnessEventPayloadV1::TurnStarted(_)
                | HarnessEventPayloadV1::TurnFinished(_)
                | HarnessEventPayloadV1::SessionClosed(_)
                | HarnessEventPayloadV1::RunFinished(_)
        ) {
            assert!(LIFECYCLE_PACKAGING_ALLOWLIST.contains(&event.payload.event_type()));
        }
    }
}

fn semantic_projection(events: &[HarnessEventV1], terminal: &Value) -> Value {
    let mut projection = HarnessProjection::new(256);
    for event in events {
        // Replay exactly the durable wire representation, not the live object.
        let event = serde_json::from_value(serde_json::to_value(event).unwrap()).unwrap();
        projection.ingest(event).unwrap();
    }

    let mut threads = serde_json::Map::new();
    for stream in projection.streams().values() {
        let Some(thread_id) = &stream.thread_id else {
            continue;
        };
        let mut text = stream.text.clone();
        let mut reasoning = stream.reasoning.clone();
        let mut inputs = stream
            .turn_inputs
            .iter()
            .map(|input| json!({"content": input.content, "provenance": input.provenance}))
            .collect::<Vec<_>>();
        for turn in stream.turns.values() {
            text.push_str(&turn.text);
            reasoning.push_str(&turn.reasoning);
            inputs.extend(turn.inputs.iter().map(|input| {
                json!({
                    "content": input.content,
                    "provenance": input.provenance,
                })
            }));
        }
        let tools = stream
            .tools
            .iter()
            .map(|(id, tool)| {
                (
                    id.as_str().to_owned(),
                    json!({
                        "call": tool.call,
                        "output_deltas": tool.output_deltas,
                        "output_snapshot": tool.output_snapshot,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let controls = stream
            .resolved_controls
            .values()
            .map(|resolution| {
                json!({
                    "source": resolution.source,
                    "decision": resolution.decision,
                })
            })
            .collect::<Vec<_>>();
        threads.insert(
            thread_id.as_str().to_owned(),
            json!({
                "text": text,
                "reasoning": reasoning,
                "inputs": inputs,
                "plan": stream.plan,
                "tools": tools,
                "file_changes": stream.file_changes,
                "turn_usage": stream.turn_usage_total,
                "session_usage": stream.session_usage,
                "controls": controls,
                "unknown": stream.unknown_events.iter().map(|event| json!({"type": event.event_type, "data": event.data})).collect::<Vec<_>>(),
            }),
        );
    }
    let lineage = projection
        .threads()
        .iter()
        .filter_map(|(id, thread)| {
            thread.declaration.as_ref().map(|declaration| {
                json!({
                    "id": id,
                    "parent": declaration.parent_thread_id,
                    "kind": declaration.kind,
                    "caused_by": declaration.caused_by_tool_call_id,
                    "provider_thread_ref": declaration.provider_thread_ref,
                    "agent_metadata": declaration.agent_metadata,
                })
            })
        })
        .collect::<Vec<_>>();
    let diagnostics = events
        .iter()
        .filter_map(|event| match &event.payload {
            HarnessEventPayloadV1::Warning(value) | HarnessEventPayloadV1::Error(value) => {
                Some(json!({"type": event.payload.event_type(), "code": value.code, "message": value.message}))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    json!({
        // The reducer proves final state; the trace prevents transient deltas,
        // semantics, and exact provider identities from being hidden by a
        // later snapshot that happens to produce the same final state.
        "update_trace": normalized_update_trace(events),
        "threads": threads,
        "lineage": lineage,
        "diagnostics": diagnostics,
        "terminal": normalized_terminal(terminal),
    })
}

fn normalized_update_trace(events: &[HarnessEventV1]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| !LIFECYCLE_PACKAGING_ALLOWLIST.contains(&event.payload.event_type()))
        .map(|event| {
            let wire = serde_json::to_value(event).unwrap();
            let mut data = wire["data"].clone();
            match &event.payload {
                // run_id and interactive turn_id are lifecycle routing wrappers;
                // content, provenance, and durable thread identity remain exact.
                HarnessEventPayloadV1::TurnInput(_) => {
                    data.as_object_mut().unwrap().remove("run_id");
                }
                HarnessEventPayloadV1::ControlRequested(_) => {
                    let object = data.as_object_mut().unwrap();
                    object.remove("session_id");
                    object.remove("turn_id");
                }
                _ => {}
            }
            json!({
                "type": event.payload.event_type(),
                "semantics": event.semantics,
                "correlation": {
                    "session_id": event.correlation.session_id,
                    "thread_id": event.correlation.thread_id,
                    "item_id": event.correlation.item_id,
                    "tool_call_id": event.correlation.tool_call_id,
                    "parent_tool_call_id": event.correlation.parent_tool_call_id,
                },
                "data": data,
            })
        })
        .collect()
}

fn normalized_terminal(terminal: &Value) -> Value {
    let mut terminal = terminal.clone();
    let error = terminal.get("error").and_then(Value::as_str);
    // A persistent GUI process observes its stdout closing, while daemon
    // one-shot can additionally observe the concrete exit status. This is the
    // sole message-level packaging difference: status, result, usage, metrics,
    // structured output, and every diagnostic code remain exact.
    if error.is_some_and(|error| {
        error == "Claude stdout closed unexpectedly"
            || (error.contains("Claude exited with status")
                && error.contains("without a result record"))
    }) {
        terminal["error"] = json!("provider_process_lost");
    }
    terminal
}

fn runtime(executable: &Path) -> ClaudeRuntime {
    ClaudeRuntime::new(ClaudeProviderConfig {
        executable: Some(executable.to_path_buf()),
        cleanup_timeout: Duration::from_millis(250),
        initialization_timeout: Duration::from_secs(2),
        terminal_exit_timeout: Duration::from_millis(100),
        root_locator_resolver: Some(Arc::new(|session_id: &SessionId| {
            Ok(Some(ProviderThreadRef::new(format!(
                "fixture://root/{}",
                session_id.as_str()
            ))))
        })),
        ..ClaudeProviderConfig::default()
    })
}

fn success_script(temp: &TempDir) -> PathBuf {
    script(
        temp,
        "success",
        &scenario_script(
            r#"
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"draft"}}}'
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoned"}}'
printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2,"output_tokens":3},"content":[{"type":"text","text":"final answer"},{"type":"tool_use","id":"todo","name":"TodoWrite","input":{"todos":[{"id":"a","content":"First","status":"completed"}]}},{"type":"tool_use","id":"bash-ok","name":"Bash","input":{"command":"pwd"}},{"type":"tool_use","id":"bash-fail","name":"Bash","input":{"command":"false"}},{"type":"tool_use","id":"spawn-child","name":"Task","input":{"prompt":"child prompt","subagent_type":"researcher"}}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"bash-ok","content":"/tmp","is_error":false},{"type":"tool_result","tool_use_id":"bash-fail","content":"exit 1","is_error":true}]}}'
printf '%s\n' '{"type":"assistant","agent_id":"child-agent","parent_tool_use_id":"spawn-child","transcript_path":"subagents/agent-child.jsonl","message":{"content":[{"type":"text","text":"child answer"},{"type":"tool_use","id":"spawn-grandchild","name":"Task","input":{"prompt":"grandchild prompt"}}]}}'
printf '%s\n' '{"type":"assistant","agent_id":"grandchild-agent","parent_tool_use_id":"spawn-grandchild","transcript_path":"subagents/agent-grandchild.jsonl","message":{"content":[{"type":"text","text":"grandchild answer"}]}}'
printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo ok"},"tool_use_id":"permission-tool"}}'
IFS= read -r _control_response
printf '%s\n' '{"type":"future_provider_record","payload":{"kept":true}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"final answer","structured_output":{"ok":true},"duration_ms":12,"num_turns":1,"total_cost_usd":0.25,"usage":{"input_tokens":10,"cache_read_input_tokens":2,"output_tokens":3}}'
"#,
        ),
    )
}

fn control_wait_script(temp: &TempDir) -> PathBuf {
    script(
        temp,
        "control-failure",
        &scenario_script(
            r#"
printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo ok"},"tool_use_id":"permission-tool"}}'
sleep 30
"#,
        ),
    )
}

fn hanging_script(temp: &TempDir) -> PathBuf {
    script(temp, "hanging", &scenario_script("sleep 30"))
}

fn scenario_script(scenario: &str) -> String {
    format!(
        r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"parity-session","model":"sonnet","transcript_path":"opaque://root.jsonl"}}'
case " $* " in
  *" --input-format "*) IFS= read -r _turn ;;
esac
{scenario}
"#,
    )
}

fn script(temp: &TempDir, name: &str, body: &str) -> PathBuf {
    let path = temp.path().join(name);
    let temporary_path = temp.path().join(format!(".{name}.tmp"));
    fs::write(&temporary_path, body).unwrap();
    let mut permissions = fs::metadata(&temporary_path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&temporary_path, permissions).unwrap();
    // Linux can reject an immediate exec of a directly written script with
    // ETXTBSY. Rename publishes the fully written, executable fixture at once.
    fs::rename(&temporary_path, &path).unwrap();
    path
}
