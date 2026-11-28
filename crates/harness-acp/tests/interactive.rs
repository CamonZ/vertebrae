use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    sync::{Mutex, Notify},
    time::timeout,
};
use vertebrae_harness_acp::AcpRuntime;
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequestEnvelope, ControlResolution, ControlSink,
    EventSink, HarnessError, HarnessEventPayloadV1 as Event, HarnessEventV1, HarnessRuntime,
    PermissionMode, QuestionAnswer, RequestConfig, ResolutionSource, SendTurnRequest,
    SessionCloseStatus, SessionHandle, SessionMode, SpeedTier, StartSessionRequest, TurnSettings,
};

#[derive(Default)]
struct Events(Mutex<Vec<HarnessEventV1>>, Notify);

#[async_trait]
impl EventSink for Events {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.0.lock().await.push(event);
        self.1.notify_one();
        Ok(())
    }
}

#[derive(Default)]
struct Controls {
    pending: Notify,
}

#[async_trait]
impl ControlSink for Controls {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        let decision = match request.turn_id.as_ref().map(|id| id.as_str()) {
            Some("first") => ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
                question_id: "permission".into(),
                selected_option_ids: vec!["read-once".into()],
                free_form: None,
            }]),
            Some("stop") => {
                self.pending.notify_one();
                std::future::pending().await
            }
            _ => ControlDecision::Deny,
        };
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(decision),
            message: None,
        })
    }
}

async fn start(
    runtime: &AcpRuntime,
    cwd: PathBuf,
    events: Arc<Events>,
    controls: Arc<dyn ControlSink>,
) -> Result<Arc<dyn SessionHandle>, HarnessError> {
    runtime
        .start_session(
            StartSessionRequest {
                session_id: "test-session".into(),
                stream_id: "test-stream".into(),
                mode: Default::default(),
                config: RequestConfig {
                    working_directory: Some(cwd),
                    ..Default::default()
                },
            },
            events,
            controls,
        )
        .await
}

fn turn(id: &str, content: &str) -> SendTurnRequest {
    SendTurnRequest {
        turn_id: id.into(),
        content: content.into(),
        output_schema: None,
        settings: Default::default(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn scripted_agent_streams_approves_interrupts_and_reuses_session() {
    timeout(Duration::from_secs(15), async {
        let fixture = format!("{}/tests/fixtures/agent.py", env!("CARGO_MANIFEST_DIR"));
        let runtime = AcpRuntime::new(
            "/usr/bin/env".into(),
            vec![
                "python3".into(),
                fixture,
                "one argument with spaces".into(),
                "$HOME; literal".into(),
                "".into(),
            ],
            Default::default(),
        );
        let workspace = tempfile::tempdir().unwrap();
        let events = Arc::new(Events::default());
        let controls = Arc::new(Controls::default());
        let session = start(
            &runtime,
            workspace.path().into(),
            events.clone(),
            controls.clone(),
        )
        .await
        .unwrap();

        let first = session.send(turn("first", "first")).await.unwrap();
        assert_eq!(
            first.await_outcome().await.unwrap().status,
            CompletionStatus::Completed
        );
        let stopped = session.send(turn("stop", "stop")).await.unwrap();
        controls.pending.notified().await;
        assert!(
            session
                .send(turn("busy", "should not be sent"))
                .await
                .is_err()
        );
        stopped.interrupt().await.unwrap();
        stopped.interrupt().await.unwrap();
        assert_eq!(
            stopped.await_outcome().await.unwrap().status,
            CompletionStatus::Interrupted
        );
        let follow_up = session.send(turn("follow", "follow up")).await.unwrap();
        assert_eq!(
            follow_up.await_outcome().await.unwrap().status,
            CompletionStatus::Completed
        );
        assert_eq!(
            session.close().await.unwrap().status,
            SessionCloseStatus::Closed
        );

        let events = events.0.lock().await;
        assert_eq!(
            events
                .iter()
                .map(|event| event.payload.event_type())
                .collect::<Vec<_>>(),
            [
                "session_started",
                "turn_started",
                "text",
                "tool_call",
                "tool_output",
                "text",
                "turn_finished",
                "turn_started",
                "turn_finished",
                "turn_started",
                "text",
                "turn_finished",
                "session_closed",
            ]
        );
        let mut text = String::new();
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event.sequence, index as u64 + 1);
            if let Event::Text(chunk) = &event.payload {
                text.push_str(&chunk.text);
            }
        }
        assert_eq!(text, "Hello worldSame session");
    })
    .await
    .expect("ACP fixture timed out");
}

#[cfg(unix)]
#[path = "model/mod.rs"]
mod model;

#[tokio::test]
#[ignore = "requires an installed, signed-in ACP agent"]
async fn authenticated_agent_smoke() {
    let executable = std::env::var_os("ACP_SMOKE_EXECUTABLE").expect("set ACP_SMOKE_EXECUTABLE");
    let args = std::env::var("ACP_SMOKE_ARGS").expect("set ACP_SMOKE_ARGS to a JSON argv array");
    let runtime = AcpRuntime::new(
        executable.into(),
        serde_json::from_str(&args).unwrap(),
        Default::default(),
    );
    let workspace = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let session = start(
        &runtime,
        workspace.path().into(),
        events.clone(),
        Arc::new(Controls::default()),
    )
    .await
    .unwrap();
    eprintln!("ACP v1 handshake and session/new succeeded");
    let handle = session
        .send(turn("smoke", "Reply with ACP_OK. Do not use tools."))
        .await
        .unwrap();
    let outcome = timeout(Duration::from_secs(60), handle.await_outcome())
        .await
        .unwrap()
        .unwrap();
    session.close().await.unwrap();
    assert_eq!(
        outcome.status,
        CompletionStatus::Completed,
        "{:?}",
        outcome.error
    );
    let events = events.0.lock().await;
    assert!(
        events
            .iter()
            .any(|event| matches!(&event.payload, Event::Text(chunk) if !chunk.text.is_empty()))
    );
}

#[cfg(unix)]
fn failing_agent(mode: &str) -> AcpRuntime {
    let fixture = format!("{}/tests/fixtures/failure.py", env!("CARGO_MANIFEST_DIR"));
    AcpRuntime::new(
        "/usr/bin/env".into(),
        vec!["python3".into(), fixture, mode.into()],
        Default::default(),
    )
}

#[cfg(unix)]
#[tokio::test]
async fn startup_reports_launch_authentication_and_version_failures() {
    let workspace = tempfile::tempdir().unwrap();
    for (agent, diagnostic) in [
        (
            AcpRuntime::new(workspace.path().join("missing"), vec![], Default::default()),
            "Could not launch",
        ),
        (failing_agent("auth"), "requires authentication"),
        (failing_agent("version"), "protocol version 1"),
        (
            failing_agent("stderr"),
            "check the configured agent arguments",
        ),
    ] {
        let events = Arc::new(Events::default());
        let result = start(
            &agent,
            workspace.path().into(),
            events.clone(),
            Arc::new(Controls::default()),
        )
        .await;
        let Err(error) = result else {
            panic!("startup unexpectedly succeeded")
        };
        assert!(error.to_string().contains(diagnostic), "{error}");
        if diagnostic == "check the configured agent arguments" {
            assert!(error.to_string().contains("42"), "{error}");
            assert!(
                !error.to_string().contains("private-argument-value"),
                "{error}"
            );
        }
        assert!(events.0.lock().await.is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn transport_loss_reports_one_error_and_terminates_the_session() {
    let workspace = tempfile::tempdir().unwrap();
    for (mode, diagnostic) in [
        ("eof", "closed its output"),
        ("invalid-json", "invalid JSON"),
        ("oversize", "exceeds the size limit"),
        ("cancel-timeout", "did not acknowledge cancellation"),
        ("idle", "closed its output"),
    ] {
        timeout(Duration::from_secs(12), async {
            let events = Arc::new(Events::default());
            let controls = Arc::new(Controls::default());
            let session = start(&failing_agent(mode), workspace.path().into(), events.clone(), controls.clone()).await.unwrap();
            if mode != "idle" {
                let handle = session.send(turn("stop", "Run")).await.unwrap();
                if mode == "cancel-timeout" {
                    controls.pending.notified().await;
                    handle.interrupt().await.unwrap();
                }
                let outcome = handle.await_outcome().await.unwrap();
                assert_eq!(outcome.status, CompletionStatus::Failed);
                assert!(outcome.error.unwrap().contains(diagnostic), "{mode}");
            }
            session.termination().unwrap().await;
            assert!(matches!(session.send(turn("late", "Late")).await, Err(HarnessError::SessionNotFound(_))));
            let events = events.0.lock().await;
            let errors: Vec<_> = events.iter().filter_map(|event| match &event.payload {
                Event::Error(error) => Some((error, &event.correlation.turn_id)),
                _ => None,
            }).collect();
            let [(error, id)] = errors.as_slice() else { panic!("expected one diagnostic for {mode}: {errors:?}") };
            assert!(error.message.contains(diagnostic), "{mode}: {error:?}");
            assert_eq!(id.is_none(), mode == "idle");
            assert!(matches!(&events.last().unwrap().payload, Event::SessionClosed(outcome) if outcome.status == SessionCloseStatus::ProcessLost));
        }).await.unwrap_or_else(|_| panic!("failure test timed out: {mode}"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn discovered_options_drive_configured_turns_steering_and_resume() {
    timeout(Duration::from_secs(15), async {
        let fixture = format!(
            "{}/tests/fixtures/configurable_agent.py",
            env!("CARGO_MANIFEST_DIR")
        );
        let runtime = AcpRuntime::new(
            "/usr/bin/env".into(),
            vec!["python3".into(), fixture],
            Default::default(),
        );
        let discovered = runtime.discover().await.unwrap();
        assert!(discovered.supports_steering && discovered.supports_resume);
        assert_eq!(discovered.config.current("model"), Some("default-model"));
        assert_eq!(
            discovered
                .model_options
                .iter()
                .map(|(model, config)| (
                    model.as_str(),
                    config
                        .choices("thought_level")
                        .map(|choice| choice.value.as_str())
                        .collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            [
                ("default-model", vec!["low", "high"]),
                ("second-model", vec!["medium"])
            ]
        );

        let cwd = tempfile::tempdir().unwrap();
        let events = Arc::new(Events::default());
        let controls = Arc::new(Controls::default());
        let handle = start(
            &runtime,
            cwd.path().into(),
            events.clone(),
            controls.clone(),
        )
        .await
        .unwrap();
        let mut request = turn("configured", "steer this");
        request.settings = TurnSettings {
            model: Some("second-model".into()),
            reasoning_effort: Some("medium".into()),
            speed_tier: Some(SpeedTier::Fast),
            permission_mode: Some(PermissionMode::Plan),
        };
        let active = handle.send(request).await.unwrap();
        loop {
            if events.0.lock().await.iter().any(|event| {
                matches!(&event.payload,
                    Event::Text(text) if text.text == "ready"
                )
            }) {
                break;
            }
            events.1.notified().await;
        }
        assert!(
            handle
                .steer(&"stale".into(), "stale input".into())
                .await
                .is_err()
        );
        assert_eq!(
            handle
                .steer(active.turn_id(), "steered input".into())
                .await
                .unwrap(),
            *active.turn_id()
        );
        assert_eq!(
            active.await_outcome().await.unwrap().status,
            CompletionStatus::Completed
        );
        {
            let events = events.0.lock().await;
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event.payload, Event::TurnFinished(_)))
                    .count(),
                1
            );
            assert!(events.iter().any(|event| matches!(&event.payload,
                Event::TurnInput(input) if input.content == "steered input"
            )));
        }

        let mut invalid = turn("invalid", "this prompt must never be sent");
        invalid.settings.reasoning_effort = Some("high".into());
        let outcome = handle
            .send(invalid)
            .await
            .unwrap()
            .await_outcome()
            .await
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Failed);
        assert_eq!(
            handle
                .send(turn("retry", "after rejection"))
                .await
                .unwrap()
                .await_outcome()
                .await
                .unwrap()
                .status,
            CompletionStatus::Completed
        );
        let resume_id = handle.provider_resume_id().unwrap().clone();
        handle.close().await.unwrap();

        let resumed = runtime
            .start_session(
                StartSessionRequest {
                    session_id: "resumed".into(),
                    stream_id: "resumed".into(),
                    mode: SessionMode::Resume(resume_id.clone()),
                    config: RequestConfig {
                        working_directory: Some(cwd.path().into()),
                        ..Default::default()
                    },
                },
                events,
                controls,
            )
            .await
            .unwrap();
        assert_eq!(resumed.provider_resume_id(), Some(&resume_id));
        assert_eq!(
            resumed
                .send(turn("continued", "after resume"))
                .await
                .unwrap()
                .await_outcome()
                .await
                .unwrap()
                .status,
            CompletionStatus::Completed
        );
        resumed.close().await.unwrap();
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn config_transport_failure_retires_the_session_before_prompting() {
    for mode in ["config-eof", "config-invalid", "config-timeout"] {
        let fixture = format!(
            "{}/tests/fixtures/configurable_agent.py",
            env!("CARGO_MANIFEST_DIR")
        );
        let runtime = AcpRuntime::new(
            "/usr/bin/env".into(),
            vec!["python3".into(), fixture, mode.into()],
            Default::default(),
        );
        let cwd = tempfile::tempdir().unwrap();
        let events = Arc::new(Events::default());
        let handle = start(
            &runtime,
            cwd.path().into(),
            events.clone(),
            Arc::new(Controls::default()),
        )
        .await
        .unwrap();
        let mut request = turn("config", "this prompt must never be sent");
        request.settings.model = Some("second-model".into());
        let active = handle.send(request).await.unwrap();
        let outcome = timeout(Duration::from_secs(13), active.await_outcome())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Failed, "{mode}");
        timeout(Duration::from_secs(4), handle.termination().unwrap())
            .await
            .unwrap();
        let events = events.0.lock().await;
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.payload, Event::Error(_)))
                .count(),
            1,
            "{mode}"
        );
        assert!(
            events
                .iter()
                .all(|e| !matches!(e.payload, Event::Text(_) | Event::Warning(_))),
            "{mode}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn load_only_agent_restores_id_exposes_legacy_modes_and_reports_context() {
    let fixture = format!(
        "{}/tests/fixtures/load_agent.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let runtime = AcpRuntime::new(
        "/usr/bin/env".into(),
        vec!["python3".into(), fixture],
        Default::default(),
    );
    let discovery = runtime.discover().await.unwrap();
    assert!(discovery.supports_resume);
    assert_eq!(
        discovery
            .config
            .permission_modes()
            .map(|(mode, _)| mode)
            .collect::<Vec<_>>(),
        [
            PermissionMode::Default,
            PermissionMode::BypassPermissions,
            PermissionMode::Auto
        ]
    );
    let cwd = tempfile::tempdir().unwrap();
    let controls = Arc::new(Controls::default());
    let events = Arc::new(Events::default());
    let original = start(
        &runtime,
        cwd.path().into(),
        events.clone(),
        controls.clone(),
    )
    .await
    .unwrap();
    let id = original.provider_resume_id().unwrap().clone();
    original.close().await.unwrap();

    let history = runtime
        .load_history(Some(cwd.path().into()), id.as_str())
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert!(!history[0].user);
    assert_eq!(history[0].text, "history");

    let events = Arc::new(Events::default());
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: "restored".into(),
                stream_id: "restored".into(),
                mode: SessionMode::Resume(id.clone()),
                config: RequestConfig {
                    working_directory: Some(cwd.path().into()),
                    ..Default::default()
                },
            },
            events.clone(),
            controls,
        )
        .await
        .unwrap();
    assert_eq!(session.provider_resume_id(), Some(&id));

    for (id, permission, wire_mode) in [
        ("auto", PermissionMode::Auto, "auto"),
        (
            "bypass",
            PermissionMode::BypassPermissions,
            "dangerously-skip-permissions",
        ),
        ("default", PermissionMode::Default, "ask"),
    ] {
        let mut request = turn(id, wire_mode);
        request.settings.permission_mode = Some(permission);
        let outcome = session
            .send(request)
            .await
            .unwrap()
            .await_outcome()
            .await
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Completed);
    }
    session.close().await.unwrap();
    let events = events.0.lock().await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.payload, Event::Text(_)))
    );
    let usage: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.payload {
            Event::Usage(usage) => usage.session_snapshot.as_ref(),
            _ => None,
        })
        .map(|usage| (usage.context_tokens, usage.context_window))
        .collect();
    assert_eq!(
        usage,
        [
            vec![(Some(31), Some(200))],
            [(Some(79), Some(200)), (Some(41), Some(200))].repeat(3),
        ]
        .concat()
    );
}

struct NoWorkflowControls;

#[async_trait]
impl ControlSink for NoWorkflowControls {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        panic!("an unattended ACP run asked the desktop for permission");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn workflow_cancel_settles_during_open_or_model_configuration() {
    use vertebrae_harness_core::RunRequest;
    for phase in ["cancel-open", "cancel-settings"] {
        timeout(Duration::from_secs(8), async {
            let checkpoint = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let events = Arc::new(Events::default());
            let runtime = failing_agent(phase);
            let run = runtime
                .run_once(
                    RunRequest {
                        run_id: phase.into(),
                        stream_id: phase.into(),
                        prompt: "never sent".into(),
                        config: RequestConfig {
                            model: Some("selected".into()),
                            environment: [(
                                "VTB_ACP_CANCEL_CHECKPOINT".into(),
                                checkpoint.local_addr().unwrap().to_string(),
                            )]
                            .into(),
                            ..Default::default()
                        },
                    },
                    events.clone(),
                    Arc::new(NoWorkflowControls),
                )
                .await
                .unwrap();
            let _connection = checkpoint.accept().await.unwrap();
            run.cancel().await.unwrap();
            run.cancel().await.unwrap();
            let outcome = run.await_outcome().await.unwrap();
            assert_eq!(outcome.status, CompletionStatus::Cancelled);
            let events = events.0.lock().await;
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].payload, Event::RunFinished(outcome));
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn workflow_rejects_unsupported_requests_before_launch() {
    use vertebrae_harness_core::RunRequest;
    let agent = AcpRuntime::new("/missing-acp-executable".into(), vec![], Default::default());
    for (prompt, config) in [
        (" ", RequestConfig::default()),
        (
            "prompt",
            RequestConfig {
                read_only: true,
                ..Default::default()
            },
        ),
        (
            "prompt",
            RequestConfig {
                output_schema: Some(serde_json::json!({})),
                ..Default::default()
            },
        ),
        (
            "prompt",
            RequestConfig {
                personality: Some("style".into()),
                ..Default::default()
            },
        ),
        (
            "prompt",
            RequestConfig {
                verbosity: Some(vertebrae_harness_core::OutputVerbosity::Low),
                ..Default::default()
            },
        ),
        (
            "prompt",
            RequestConfig {
                developer_instructions: Some("instruction".into()),
                ..Default::default()
            },
        ),
    ] {
        let events = Arc::new(Events::default());
        let result = agent
            .run_once(
                RunRequest {
                    run_id: "bad".into(),
                    stream_id: "bad".into(),
                    prompt: prompt.into(),
                    config,
                },
                events.clone(),
                Arc::new(NoWorkflowControls),
            )
            .await;
        assert!(matches!(
            result,
            Err(HarnessError::InvalidRequest(_) | HarnessError::Unsupported(_))
        ));
        assert!(events.0.lock().await.is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn workflow_outcome_matches_the_scripted_acp_exchange() {
    use vertebrae_harness_core::RunRequest;

    timeout(Duration::from_secs(15), async {
        let fixture = format!("{}/tests/fixtures/agent.py", env!("CARGO_MANIFEST_DIR"));
        let runtime = AcpRuntime::new(
            "/usr/bin/env".into(),
            vec![
                "python3".into(),
                fixture,
                "--workflow".into(),
                "literal $HOME; value".into(),
            ],
            Default::default(),
        );
        let workspace = tempfile::tempdir().unwrap();
        let cwd = workspace.path().canonicalize().unwrap();
        for (prompt, status) in [
            ("complete", CompletionStatus::Completed),
            ("large", CompletionStatus::Completed),
            ("cancel", CompletionStatus::Cancelled),
            ("fail", CompletionStatus::Failed),
        ] {
            let events = Arc::new(Events::default());
            let run = runtime
                .run_once(
                    RunRequest {
                        run_id: prompt.into(),
                        stream_id: "test-stream".into(),
                        prompt: prompt.into(),
                        config: RequestConfig {
                            working_directory: Some(cwd.clone()),
                            model: Some("selected".into()),
                            environment: [(
                                "VTB_ACP_WORKSPACE".into(),
                                cwd.to_str().unwrap().into(),
                            )]
                            .into(),
                            ..Default::default()
                        },
                    },
                    events.clone(),
                    Arc::new(NoWorkflowControls),
                )
                .await
                .unwrap();
            if prompt == "cancel" {
                loop {
                    let notified = events.1.notified();
                    if events
                        .0
                        .lock()
                        .await
                        .iter()
                        .any(|event| matches!(event.payload, Event::Text(_)))
                    {
                        break;
                    }
                    notified.await;
                }
                run.cancel().await.unwrap();
                run.cancel().await.unwrap();
            }
            let outcome = run.await_outcome().await.unwrap();
            assert_eq!(outcome.status, status, "{outcome:?}");
            let events = events.0.lock().await;
            let terminals: Vec<_> = events
                .iter()
                .filter(|event| event.payload.is_lifecycle_terminal())
                .collect();
            assert_eq!(terminals.len(), 1);
            assert_eq!(terminals[0].payload, Event::RunFinished(outcome.clone()));
            assert_eq!(events.last(), terminals.last().copied());
            assert!(
                events
                    .iter()
                    .all(|event| event.correlation.run_id.as_ref() == Some(run.run_id()))
            );
            match status {
                CompletionStatus::Completed => {
                    let expected = if prompt == "large" {
                        format!("Hello {}", "x".repeat(1200 * 1024))
                    } else {
                        "Hello workflow".to_string()
                    };
                    assert_eq!(outcome.result_text.as_deref(), Some(expected.as_str()));
                    assert_eq!(
                        std::fs::read_to_string(cwd.join("close-ack")).unwrap(),
                        prompt
                    );
                }
                CompletionStatus::Failed => {
                    let error = outcome.error.unwrap();
                    assert!(
                        error.contains("session/prompt failed (code -32603)"),
                        "{error}"
                    );
                    assert!(!error.contains("private provider detail"), "{error}");
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
}
