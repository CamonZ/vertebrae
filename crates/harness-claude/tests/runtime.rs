#![cfg(unix)]

use std::{
    fs,
    future::pending,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use tempfile::TempDir;
use vertebrae_harness_claude::{ClaudeProviderConfig, ClaudeRuntime};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequest, ControlRequestEnvelope, ControlResolution,
    ControlSink, EventSink, GrantScope, HarnessError, HarnessEventPayloadV1, HarnessEventV1,
    HarnessProjection, HarnessRuntime, ProviderThreadRef, QuestionAnswer, RequestConfig,
    ResolutionSource, RunId, RunRequest, SendTurnRequest, SessionId, StartSessionRequest, StreamId,
    ThreadKind, TurnId, TurnInputProvenance,
};

#[derive(Default)]
struct CollectSink(Mutex<Vec<HarnessEventV1>>);

#[async_trait]
impl EventSink for CollectSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}

#[derive(Default)]
struct ResolvingControls(Mutex<Vec<ControlRequestEnvelope>>);

#[async_trait]
impl ControlSink for ResolvingControls {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.0.lock().unwrap().push(request.clone());
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(
                vertebrae_harness_core::ControlDecision::PermissionsGranted {
                    permissions: vec!["fixture".into()],
                    scope: GrantScope::Turn,
                },
            ),
            message: None,
        })
    }
}

struct FailingControls;

#[async_trait]
impl ControlSink for FailingControls {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        Err(HarnessError::Control("fixture control failure".into()))
    }
}

struct FailingSink;

#[async_trait]
impl EventSink for FailingSink {
    async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
        Err(HarnessError::EventSink("fixture sink failure".into()))
    }
}

struct NeverControls;

#[async_trait]
impl ControlSink for NeverControls {
    async fn request(
        &self,
        _request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        pending().await
    }
}

struct AnsweringQuestions;

#[async_trait]
impl ControlSink for AnsweringQuestions {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        let question_id = match &request.request {
            ControlRequest::UserQuestion { questions } => questions[0].id.clone(),
            other => panic!("expected user question, got {other:?}"),
        };
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
                question_id,
                selected_option_ids: vec!["Production".into()],
                free_form: None,
            }])),
            message: None,
        })
    }
}

struct CancelThenResolve;

#[async_trait]
impl ControlSink for CancelThenResolve {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        if request.request_id.as_str() == "cancelled-control" {
            return pending().await;
        }
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(ControlDecision::AllowOnce),
            message: None,
        })
    }
}

struct FailWarningsSink;

#[async_trait]
impl EventSink for FailWarningsSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        if matches!(event.payload, HarnessEventPayloadV1::Warning(_)) {
            Err(HarnessError::EventSink("warning sink failure".into()))
        } else {
            Ok(())
        }
    }
}

fn assert_timeout_resolution(sink: &CollectSink, request_id: &str) {
    assert!(sink.0.lock().unwrap().iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::ControlResolved(resolution)
            if resolution.request_id.as_str() == request_id
                && resolution.source == ResolutionSource::Timeout
                && resolution.decision == Some(ControlDecision::Deny)
    )));
}

#[tokio::test]
async fn one_shot_emits_ordered_events_and_returns_structured_outcome() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "one-shot",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"conversation-run","model":"sonnet","transcript_path":"opaque://run.jsonl"}'
printf '%s\n' 'provider warning' >&2
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"hello","structured_output":{"answer":42},"usage":{"input_tokens":7,"output_tokens":3}}'
"#,
    );
    let runtime = runtime(executable);
    let sink = Arc::new(CollectSink::default());
    let controls = Arc::new(ResolvingControls::default());
    let handle = runtime
        .run_once(
            RunRequest {
                run_id: RunId::from("run-1"),
                stream_id: StreamId::from("stream-1"),
                prompt: "exact human prompt\nsecond line".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            controls,
        )
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(3), handle.await_outcome())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    assert_eq!(outcome.result_text.as_deref(), Some("hello"));
    assert_eq!(outcome.structured_output.unwrap()["answer"], 42);

    let events = sink.0.lock().unwrap();
    assert!(!events.is_empty());
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.stream_id.as_str(), "stream-1");
        assert_eq!(event.sequence, index as u64 + 1);
        assert_eq!(event.correlation.run_id.as_ref().unwrap().as_str(), "run-1");
    }
    let input = events
        .iter()
        .find_map(|event| match &event.payload {
            HarnessEventPayloadV1::TurnInput(input) => Some(input),
            _ => None,
        })
        .unwrap();
    assert_eq!(input.thread_id.as_str(), "conversation-run");
    assert_eq!(input.content, "exact human prompt\nsecond line");
    assert_eq!(input.provenance, TurnInputProvenance::Human);
    assert!(events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::Warning(warning) if warning.code.as_deref() == Some("claude_stderr"))));
}

#[tokio::test]
async fn one_shot_clean_exit_without_result_is_completed_without_output_or_metrics() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "clean-exit",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"clean-exit-session"}'
"#,
    );
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("clean-exit-run"),
                stream_id: StreamId::from("clean-exit-stream"),
                prompt: "finish quietly".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();

    let outcome = handle.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    assert_eq!(outcome.result_text, None);
    assert_eq!(outcome.structured_output, None);
    assert_eq!(outcome.usage, None);
    assert_eq!(outcome.metrics, Default::default());
    assert_eq!(outcome.error, None);
}

#[tokio::test]
async fn nested_agents_keep_independent_sequences_and_canonical_correlations() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "nested-agents",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"nested-session","transcript_path":"opaque://root.jsonl"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"spawn-child","name":"Task","input":{"prompt":"exact child prompt","subagent_type":"researcher"}}]}}'
printf '%s\n' '{"type":"assistant","agent_id":"child-agent","parent_tool_use_id":"spawn-child","transcript_path":"subagents/agent-child.jsonl","message":{"content":[{"type":"text","text":"child answer"},{"type":"tool_use","id":"spawn-grandchild","name":"Task","input":{"prompt":"exact grandchild prompt","subagent_type":"reader"}}]}}'
printf '%s\n' '{"type":"assistant","agent_id":"grandchild-agent","parent_tool_use_id":"spawn-grandchild","transcript_path":"subagents/agent-grandchild.jsonl","message":{"content":[{"type":"text","text":"grandchild answer"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("nested-run"),
                stream_id: StreamId::from("nested-stream"),
                prompt: "root prompt".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );

    let events = sink.0.lock().unwrap();
    let streams = [
        ("nested-stream", "nested-session"),
        ("nested-stream/agent/child-agent", "child-agent"),
        ("nested-stream/agent/grandchild-agent", "grandchild-agent"),
    ];
    for (stream_id, thread_id) in streams {
        let stream_events = events
            .iter()
            .filter(|event| event.stream_id.as_str() == stream_id)
            .collect::<Vec<_>>();
        assert!(!stream_events.is_empty(), "missing stream {stream_id}");
        for (index, event) in stream_events.iter().enumerate() {
            assert_eq!(event.sequence, index as u64 + 1);
            assert_eq!(
                event.correlation.session_id.as_ref().unwrap().as_str(),
                "nested-session"
            );
            assert_eq!(
                event.correlation.thread_id.as_ref().unwrap().as_str(),
                thread_id
            );
            assert_eq!(
                event.correlation.run_id.as_ref().unwrap().as_str(),
                "nested-run"
            );
        }
    }

    let child = events
        .iter()
        .find_map(|event| match &event.payload {
            HarnessEventPayloadV1::ThreadDeclared(declaration)
                if declaration.thread_id.as_str() == "child-agent" =>
            {
                Some(declaration)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(child.kind, ThreadKind::Subagent);
    assert_eq!(
        child.parent_thread_id.as_ref().unwrap().as_str(),
        "nested-session"
    );
    assert_eq!(
        child.caused_by_tool_call_id.as_ref().unwrap().as_str(),
        "spawn-child"
    );
    assert_eq!(
        child.provider_thread_ref.as_ref().unwrap().as_str(),
        "subagents/agent-child.jsonl"
    );

    let grandchild = events
        .iter()
        .find_map(|event| match &event.payload {
            HarnessEventPayloadV1::ThreadDeclared(declaration)
                if declaration.thread_id.as_str() == "grandchild-agent" =>
            {
                Some(declaration)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        grandchild.parent_thread_id.as_ref().unwrap().as_str(),
        "child-agent"
    );
    assert_eq!(
        grandchild.caused_by_tool_call_id.as_ref().unwrap().as_str(),
        "spawn-grandchild"
    );
    assert!(events.iter().all(|event| {
        event.stream_id.as_str() != "nested-stream"
            || !matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "child answer" || text.text == "grandchild answer")
    }));
}

#[tokio::test]
async fn persistent_session_initializes_on_first_turn_and_supports_multiple_turns() {
    let temp = TempDir::new().unwrap();
    let capture = temp.path().join("stdin.jsonl");
    let executable = script(
        &temp,
        "persistent",
        r#"#!/bin/sh
initialized=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CAPTURE"
  if [ "$initialized" -eq 0 ]; then
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"conversation-session","model":"sonnet","transcript_path":"opaque://session.jsonl"}'
    initialized=1
  fi
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"answer"}]}}'
  printf '%s\n' '{"type":"result","subtype":"success","result":"answer","usage":{"input_tokens":2,"output_tokens":1}}'
done
"#,
    );
    let mut provider = ClaudeProviderConfig {
        executable: Some(executable),
        ..ClaudeProviderConfig::default()
    };
    provider
        .environment
        .insert("CAPTURE".into(), capture.to_string_lossy().into_owned());
    let runtime = ClaudeRuntime::new(provider);
    let sink = Arc::new(CollectSink::default());
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("requested-session"),
                stream_id: StreamId::from("session-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(session.session_id().as_str(), "requested-session");
    assert!(session.provider_resume_id().is_none());

    for (id, content) in [("turn-1", "first\nexact"), ("turn-2", "second exact")] {
        let turn = session
            .send(SendTurnRequest {
                turn_id: TurnId::from(id),
                content: content.into(),
                output_schema: None,
            })
            .await
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(3), turn.await_outcome())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Completed);
    }
    let close = session.close().await.unwrap();
    assert_eq!(
        close.status,
        vertebrae_harness_core::SessionCloseStatus::Closed
    );

    let lines = fs::read_to_string(capture).unwrap();
    let inputs = lines
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert!(inputs[0]["session_id"].is_null());
    assert_eq!(inputs[0]["message"]["content"], "first\nexact");
    assert_eq!(inputs[1]["message"]["content"], "second exact");

    let events = sink.0.lock().unwrap();
    let init = events
        .iter()
        .position(|event| matches!(&event.payload, HarnessEventPayloadV1::SessionStarted(_)))
        .unwrap();
    let turn_started = events
        .iter()
        .position(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnStarted(_)))
        .unwrap();
    let turn_input = events
        .iter()
        .position(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnInput(_)))
        .unwrap();
    assert!(init < turn_started && turn_started < turn_input);

    let turn_inputs = events
        .iter()
        .filter_map(|event| match &event.payload {
            HarnessEventPayloadV1::TurnInput(input) => Some((event, input)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(turn_inputs.len(), 2);
    assert!(turn_inputs.iter().all(|(event, input)| {
        event.correlation.session_id.as_ref().unwrap().as_str() == "conversation-session"
            && input.thread_id.as_str() == "conversation-session"
    }));
}

#[tokio::test]
async fn persistent_session_survives_compact_skill_records() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "persistent-compact",
        r#"#!/bin/sh
initialized=0
while IFS= read -r line; do
  if [ "$initialized" -eq 0 ]; then
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"compact-session"}'
    initialized=1
  fi
  case "$line" in
    *compact*)
      printf '%s\n' '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}'
      printf '%s\n' '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context."}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}'
      ;;
    *clear*)
      printf '%s\n' '{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":"<local-command-stdout>Cleared </local-command-stdout>"}}'
      ;;
  esac
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"skill handled"}]}}'
  printf '%s\n' '{"type":"result","subtype":"success","result":"skill handled"}'
done
"#,
    );
    let session = runtime(executable)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("requested-compact-session"),
                stream_id: StreamId::from("compact-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();

    for (turn_id, content) in [
        ("compact-turn", "/compact"),
        ("clear-turn", "/clear"),
        ("follow-up", "run skill"),
    ] {
        let turn = session
            .send(SendTurnRequest {
                turn_id: TurnId::from(turn_id),
                content: content.into(),
                output_schema: None,
            })
            .await
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(3), turn.await_outcome())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.status, CompletionStatus::Completed);
        assert_eq!(outcome.result_text.as_deref(), Some("skill handled"));
    }
    assert_eq!(
        session.close().await.unwrap().status,
        vertebrae_harness_core::SessionCloseStatus::Closed
    );
}

#[tokio::test]
async fn cancellation_and_nonzero_exit_settle_once() {
    let temp = TempDir::new().unwrap();
    let slow = script(
        &temp,
        "slow",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"slow-session"}'
sleep 30
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(slow)
        .run_once(
            RunRequest {
                run_id: RunId::from("cancel-run"),
                stream_id: StreamId::from("cancel-stream"),
                prompt: "wait".into(),
                config: RequestConfig::default(),
            },
            sink,
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    handle.cancel().await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(3), handle.await_outcome())
        .await
        .unwrap()
        .unwrap();
    let second = handle.await_outcome().await.unwrap();
    assert_eq!(first.status, CompletionStatus::Cancelled);
    assert_eq!(second.status, CompletionStatus::Cancelled);

    let failing = script(
        &temp,
        "failing",
        "#!/bin/sh\nprintf '%s\\n' 'fatal' >&2\nexit 17\n",
    );
    let handle = runtime(failing)
        .run_once(
            RunRequest {
                run_id: RunId::from("fail-run"),
                stream_id: StreamId::from("fail-stream"),
                prompt: "fail".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    let outcome = handle.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(outcome.error.unwrap().contains("status"));
}

#[tokio::test]
async fn controls_resolve_as_events_and_delivery_failures_settle_the_run() {
    let temp = TempDir::new().unwrap();
    let response_capture = temp.path().join("control-response.jsonl");
    let body = format!(
        r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"control-session"}}'
printf '%s\n' '{{"type":"control_request","request_id":"control-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"pwd"}},"tool_use_id":"tool-1"}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done"}}'
"#,
        response_capture.display()
    );
    let controls = Arc::new(ResolvingControls::default());
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(script(&temp, "controls", &body))
        .run_once(
            RunRequest {
                run_id: RunId::from("control-run"),
                stream_id: StreamId::from("control-stream"),
                prompt: "ask".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            controls.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    assert_eq!(controls.0.lock().unwrap().len(), 1);
    let response: serde_json::Value =
        serde_json::from_str(fs::read_to_string(&response_capture).unwrap().trim()).unwrap();
    assert_eq!(response["type"], "control_response");
    assert_eq!(response["response"]["request_id"], "control-1");
    assert_eq!(response["response"]["response"]["behavior"], "allow");
    {
        let events = sink.0.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|event| matches!(event.payload, HarnessEventPayloadV1::ControlRequested(_)))
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event.payload, HarnessEventPayloadV1::ControlResolved(_)))
        );
    }

    let failed = runtime(script(&temp, "control-failure", &body))
        .run_once(
            RunRequest {
                run_id: RunId::from("control-fail"),
                stream_id: StreamId::from("control-fail-stream"),
                prompt: "ask".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(FailingControls),
        )
        .await
        .unwrap();
    let outcome = failed.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(outcome.error.unwrap().contains("control request failed"));

    let failed = runtime(script(&temp, "sink-failure", &body))
        .run_once(
            RunRequest {
                run_id: RunId::from("sink-fail"),
                stream_id: StreamId::from("sink-fail-stream"),
                prompt: "ask".into(),
                config: RequestConfig::default(),
            },
            Arc::new(FailingSink),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert!(
        failed
            .await_outcome()
            .await
            .unwrap_err()
            .to_string()
            .contains("event sink")
    );
}

#[tokio::test]
async fn control_request_timeouts_deny_and_reply_for_one_shot_and_persistent_runs() {
    let temp = TempDir::new().unwrap();
    let one_shot_response = temp.path().join("one-shot-timeout-response.jsonl");
    let one_shot = script(
        &temp,
        "one-shot-control-timeout",
        &format!(
            r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"timeout-run"}}'
printf '%s\n' '{{"type":"control_request","request_id":"timeout-one-shot","timeout_ms":10,"request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"pwd"}}}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done"}}'
"#,
            one_shot_response.display()
        ),
    );
    let one_shot_sink = Arc::new(CollectSink::default());
    let run = runtime(one_shot)
        .run_once(
            RunRequest {
                run_id: RunId::from("timeout-one-shot-run"),
                stream_id: StreamId::from("timeout-one-shot-stream"),
                prompt: "go".into(),
                config: RequestConfig::default(),
            },
            one_shot_sink.clone(),
            Arc::new(NeverControls),
        )
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), run.await_outcome())
            .await
            .unwrap()
            .unwrap()
            .status,
        CompletionStatus::Completed
    );
    assert_timeout_resolution(&one_shot_sink, "timeout-one-shot");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            fs::read_to_string(one_shot_response).unwrap().trim()
        )
        .unwrap()["response"]["response"]["behavior"],
        "deny"
    );

    let persistent_response = temp.path().join("persistent-timeout-response.jsonl");
    let persistent = script(
        &temp,
        "persistent-control-timeout",
        &format!(
            r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"timeout-session"}}'
IFS= read -r _
printf '%s\n' '{{"type":"control_request","request_id":"timeout-persistent","timeout_ms":10,"request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"pwd"}}}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done"}}'
"#,
            persistent_response.display()
        ),
    );
    let persistent_sink = Arc::new(CollectSink::default());
    let session = runtime(persistent)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("timeout-session-request"),
                stream_id: StreamId::from("timeout-session-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            persistent_sink.clone(),
            Arc::new(NeverControls),
        )
        .await
        .unwrap();
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("timeout-session-turn"),
            content: "go".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
            .await
            .unwrap()
            .unwrap()
            .status,
        CompletionStatus::Completed
    );
    assert_timeout_resolution(&persistent_sink, "timeout-persistent");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            fs::read_to_string(persistent_response).unwrap().trim()
        )
        .unwrap()["response"]["response"]["behavior"],
        "deny"
    );
}

#[tokio::test]
async fn ask_user_question_preserves_questions_and_writes_exact_answer_shape() {
    let temp = TempDir::new().unwrap();
    let response_capture = temp.path().join("question-response.jsonl");
    let executable = script(
        &temp,
        "questions",
        &format!(
            r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"question-session"}}'
printf '%s\n' '{{"type":"control_request","request_id":"question-control","request":{{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{{"questions":[{{"question":"Which environment?","header":"Environment","options":[{{"label":"Staging","description":"Use staging"}},{{"label":"Production","description":"Use production"}}],"multiSelect":false}}]}}}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"answered"}}'
"#,
            response_capture.display()
        ),
    );
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("question-run"),
                stream_id: StreamId::from("question-stream"),
                prompt: "ask".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(AnsweringQuestions),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let response: serde_json::Value =
        serde_json::from_str(fs::read_to_string(response_capture).unwrap().trim()).unwrap();
    let updated_input = &response["response"]["response"]["updatedInput"];
    assert_eq!(response["response"]["request_id"], "question-control");
    assert_eq!(
        updated_input["questions"][0]["header"],
        serde_json::json!("Environment")
    );
    assert_eq!(
        updated_input["questions"][0]["options"][1]["description"],
        serde_json::json!("Use production")
    );
    assert_eq!(
        updated_input["answers"]["Which environment?"],
        serde_json::json!("Production")
    );
}

#[tokio::test]
async fn provider_control_cancel_aborts_pending_request_and_allows_future_controls() {
    let temp = TempDir::new().unwrap();
    let response_capture = temp.path().join("post-cancel-response.jsonl");
    let executable = script(
        &temp,
        "provider-cancel",
        &format!(
            r#"#!/bin/sh
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"cancel-session"}}'
printf '%s\n' '{{"type":"control_request","request_id":"cancelled-control","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"sleep 10"}}}}}}'
printf '%s\n' '{{"type":"control_cancel_request","request_id":"cancelled-control"}}'
printf '%s\n' '{{"type":"control_request","request_id":"future-control","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"pwd"}}}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done"}}'
"#,
            response_capture.display()
        ),
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("provider-cancel-run"),
                stream_id: StreamId::from("provider-cancel-stream"),
                prompt: "go".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(CancelThenResolve),
        )
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), handle.await_outcome())
            .await
            .unwrap()
            .unwrap()
            .status,
        CompletionStatus::Completed
    );
    let response: serde_json::Value =
        serde_json::from_str(fs::read_to_string(response_capture).unwrap().trim()).unwrap();
    assert_eq!(response["response"]["request_id"], "future-control");
    let events = sink.0.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                &event.payload,
                HarnessEventPayloadV1::ControlResolved(resolution)
                    if resolution.request_id.as_str() == "cancelled-control"
                        && resolution.source == ResolutionSource::Provider
                        && resolution.decision == Some(ControlDecision::Cancel)
            ))
            .count(),
        1
    );
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::ControlResolved(resolution)
            if resolution.request_id.as_str() == "future-control"
                && resolution.source == ResolutionSource::Consumer
    )));
}

#[tokio::test]
async fn lost_persistent_process_settles_a_queued_or_active_turn() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "lost",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"lost-session"}'
exit 9
"#,
    );
    let runtime = runtime(executable);
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("requested"),
                stream_id: StreamId::from("lost-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    match session
        .send(SendTurnRequest {
            turn_id: TurnId::from("lost-turn"),
            content: "hello".into(),
            output_schema: None,
        })
        .await
    {
        Ok(turn) => {
            let outcome = tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(outcome.status, CompletionStatus::Failed);
            assert!(outcome.error.as_deref().unwrap().contains("stdout"));
        }
        Err(error) => assert!(error.to_string().contains("Claude")),
    }
    let close = session.close().await.unwrap();
    assert_eq!(
        close.status,
        vertebrae_harness_core::SessionCloseStatus::Failed
    );
}

#[tokio::test]
async fn interrupt_settles_the_turn_and_reaps_the_persistent_process() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "interrupt",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"interrupt-session"}'
IFS= read -r _
sleep 30
"#,
    );
    let session = runtime(executable)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("requested"),
                stream_id: StreamId::from("interrupt-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("interrupt-turn"),
            content: "start".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    turn.interrupt().await.unwrap();
    let first = turn.await_outcome().await.unwrap();
    let second = turn.await_outcome().await.unwrap();
    assert_eq!(first.status, CompletionStatus::Interrupted);
    assert_eq!(second.status, CompletionStatus::Interrupted);
    assert_eq!(
        session.close().await.unwrap().status,
        vertebrae_harness_core::SessionCloseStatus::Closed
    );
}

#[tokio::test]
async fn resumed_session_handle_and_captured_launch_use_canonical_identity_and_exact_process_state()
{
    let temp = TempDir::new().unwrap();
    let cwd = temp.path().join("project");
    fs::create_dir(&cwd).unwrap();
    let capture = temp.path().join("launch.txt");
    let executable = script(
        &temp,
        "resume",
        &format!(
            r#"#!/bin/sh
{{ printf 'cwd=%s\n' "$PWD"; printf 'compat=%s\n' "$COMPAT"; printf 'arg=%s\n' "$@"; }} > '{}.tmp'
mv '{}.tmp' '{}'
printf '%s\n' '{{"type":"system","subtype":"init","session_id":"resume-canonical","model":"sonnet"}}'
while IFS= read -r _; do :; done
"#,
            capture.display(),
            capture.display(),
            capture.display()
        ),
    );
    let runtime = runtime(executable);
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("placeholder"),
                stream_id: StreamId::from("resume-stream"),
                resume_id: Some(vertebrae_harness_core::ProviderResumeId::from(
                    "resume-canonical",
                )),
                config: RequestConfig {
                    working_directory: Some(cwd.clone()),
                    environment: std::collections::BTreeMap::from([(
                        "COMPAT".into(),
                        "yes".into(),
                    )]),
                    ..RequestConfig::default()
                },
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(session.session_id().as_str(), "placeholder");
    assert_eq!(
        session.provider_resume_id().unwrap().as_str(),
        "resume-canonical"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !capture.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let launch = fs::read_to_string(capture).unwrap();
    let canonical_cwd = fs::canonicalize(&cwd).unwrap();
    assert!(
        launch.contains(&format!("cwd={}\n", canonical_cwd.display())),
        "captured launch:\n{launch}"
    );
    assert!(launch.contains("compat=yes\n"));
    assert!(launch.contains("arg=--print\n"));
    assert!(launch.contains("arg=--input-format\narg=stream-json\n"));
    assert!(launch.contains("arg=--resume=resume-canonical\n"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn initialization_timeout_fails_and_reaps_instead_of_hanging() {
    let temp = TempDir::new().unwrap();
    let marker = temp.path().join("should-not-exist");
    let executable = script(
        &temp,
        "no-init",
        &format!("#!/bin/sh\nsleep 2\ntouch '{}'\n", marker.display()),
    );
    let runtime = ClaudeRuntime::new(ClaudeProviderConfig {
        executable: Some(executable),
        initialization_timeout: Duration::from_millis(50),
        cleanup_timeout: Duration::from_millis(200),
        ..ClaudeProviderConfig::default()
    });
    let started = Instant::now();
    let session = runtime
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("placeholder"),
                stream_id: StreamId::from("timeout-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    let result = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("timeout-turn"),
            content: "hello".into(),
            output_schema: None,
        })
        .await;
    let error = match result {
        Ok(_) => panic!("first turn should fail when Claude never initializes"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!marker.exists());
}

#[tokio::test]
async fn terminal_result_then_hang_finishes_once_and_reaps_promptly() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "terminal-hang",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"terminal-session"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
sleep 30
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let started = Instant::now();
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("terminal-run"),
                stream_id: StreamId::from("terminal-stream"),
                prompt: "finish".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        sink.0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
            .count(),
        1
    );
}

#[tokio::test]
async fn never_resolving_controls_do_not_block_cancel_or_interrupt() {
    let temp = TempDir::new().unwrap();
    let control_line = r#"{"type":"control_request","request_id":"never","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"}}}"#;
    let one_shot = script(
        &temp,
        "never-run",
        &format!(
            "#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"never-run-session\"}}'\nprintf '%s\\n' '{}'\nsleep 30\n",
            control_line
        ),
    );
    let run_sink = Arc::new(CollectSink::default());
    let run = runtime(one_shot)
        .run_once(
            RunRequest {
                run_id: RunId::from("never-run"),
                stream_id: StreamId::from("never-run-stream"),
                prompt: "go".into(),
                config: RequestConfig::default(),
            },
            run_sink.clone(),
            Arc::new(NeverControls),
        )
        .await
        .unwrap();
    wait_for_payload(&run_sink, |payload| {
        matches!(payload, HarnessEventPayloadV1::ControlRequested(_))
    })
    .await;
    run.cancel().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), run.await_outcome())
            .await
            .unwrap()
            .unwrap()
            .status,
        CompletionStatus::Cancelled
    );
    assert!(run_sink.0.lock().unwrap().iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::ControlResolved(resolution) if resolution.source == ResolutionSource::Cancelled)));

    let persistent = script(
        &temp,
        "never-session",
        &format!(
            "#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"never-session\"}}'\nIFS= read -r _\nprintf '%s\\n' '{}'\nsleep 30\n",
            control_line
        ),
    );
    let session_sink = Arc::new(CollectSink::default());
    let session = runtime(persistent)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::from("placeholder"),
                stream_id: StreamId::from("never-session-stream"),
                resume_id: None,
                config: RequestConfig::default(),
            },
            session_sink.clone(),
            Arc::new(NeverControls),
        )
        .await
        .unwrap();
    let turn = session
        .send(SendTurnRequest {
            turn_id: TurnId::from("never-turn"),
            content: "go".into(),
            output_schema: None,
        })
        .await
        .unwrap();
    wait_for_payload(&session_sink, |payload| {
        matches!(payload, HarnessEventPayloadV1::ControlRequested(_))
    })
    .await;
    turn.interrupt().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), turn.await_outcome())
            .await
            .unwrap()
            .unwrap()
            .status,
        CompletionStatus::Interrupted
    );
    assert!(session_sink.0.lock().unwrap().iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::ControlResolved(resolution) if resolution.source == ResolutionSource::Interrupted)));
}

#[tokio::test]
async fn usage_snapshots_and_terminal_delta_aggregate_exactly_once() {
    let temp = TempDir::new().unwrap();
    let executable = script(
        &temp,
        "usage",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"usage-session"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":5,"output_tokens":2}}}'
printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"output_tokens":4},"content":[]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done","total_cost_usd":0.25,"usage":{"input_tokens":10,"cache_read_input_tokens":3,"output_tokens":4}}'
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(executable)
        .run_once(
            RunRequest {
                run_id: RunId::from("usage-run"),
                stream_id: StreamId::from("usage-stream"),
                prompt: "usage".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let mut projection = HarnessProjection::new(64);
    for event in sink.0.lock().unwrap().iter().cloned() {
        projection.ingest(event).unwrap();
    }
    let stream = projection.stream(&StreamId::from("usage-stream")).unwrap();
    assert_eq!(stream.turn_usage_total.tokens.input_tokens, 10);
    assert_eq!(stream.turn_usage_total.tokens.cached_input_tokens, 3);
    assert_eq!(stream.turn_usage_total.tokens.output_tokens, 4);
    assert_eq!(stream.turn_usage_total.cost_microusd, 250_000);
    assert_eq!(
        stream.session_usage.as_ref().unwrap().tokens.input_tokens,
        10
    );
}

#[tokio::test]
async fn malformed_message_content_is_terminal_while_unknown_content_is_contained() {
    let temp = TempDir::new().unwrap();
    let malformed = script(
        &temp,
        "malformed-message-content",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"malformed-message"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"missing-name","input":{}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"must-not-win"}'
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(malformed)
        .run_once(
            RunRequest {
                run_id: RunId::from("malformed-message-run"),
                stream_id: StreamId::from("malformed-message-stream"),
                prompt: "go".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    let outcome = handle.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(
        outcome
            .error
            .as_deref()
            .unwrap()
            .contains("tool_use content block has no name")
    );
    {
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            HarnessEventPayloadV1::Error(error)
                if error.code.as_deref() == Some("claude_malformed_record")
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
                .count(),
            1
        );
    }

    let unknown = script(
        &temp,
        "unknown-message-content",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"unknown-message"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"future_content","payload":{"ok":true}},{"type":"text","text":"continued"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
"#,
    );
    let sink = Arc::new(CollectSink::default());
    let handle = runtime(unknown)
        .run_once(
            RunRequest {
                run_id: RunId::from("unknown-message-run"),
                stream_id: StreamId::from("unknown-message-stream"),
                prompt: "go".into(),
                config: RequestConfig::default(),
            },
            sink.clone(),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert_eq!(
        handle.await_outcome().await.unwrap().status,
        CompletionStatus::Completed
    );
    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        HarnessEventPayloadV1::Warning(warning)
            if warning.code.as_deref() == Some("claude_unknown_content_block")
    )));
    assert!(events.iter().any(
        |event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "continued")
    ));
}

#[tokio::test]
async fn diagnostic_sink_and_stdout_read_failures_are_terminal() {
    let temp = TempDir::new().unwrap();
    let warning = script(
        &temp,
        "warning-failure",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"warning-session"}'
printf '%s\n' 'warning' >&2
sleep 1
"#,
    );
    let handle = runtime(warning)
        .run_once(
            RunRequest {
                run_id: RunId::from("warning-run"),
                stream_id: StreamId::from("warning-stream"),
                prompt: "warn".into(),
                config: RequestConfig::default(),
            },
            Arc::new(FailWarningsSink),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    assert!(
        handle
            .await_outcome()
            .await
            .unwrap_err()
            .to_string()
            .contains("event sink")
    );

    let invalid = script(
        &temp,
        "invalid-utf8",
        "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"read-session\"}'\nprintf '\\377\\n'\n",
    );
    let handle = runtime(invalid)
        .run_once(
            RunRequest {
                run_id: RunId::from("read-run"),
                stream_id: StreamId::from("read-stream"),
                prompt: "read".into(),
                config: RequestConfig::default(),
            },
            Arc::new(CollectSink::default()),
            Arc::new(ResolvingControls::default()),
        )
        .await
        .unwrap();
    let outcome = handle.await_outcome().await.unwrap();
    assert_eq!(outcome.status, CompletionStatus::Failed);
    assert!(outcome.error.unwrap().contains("stdout"));
}

fn runtime(executable: PathBuf) -> ClaudeRuntime {
    ClaudeRuntime::new(ClaudeProviderConfig {
        executable: Some(executable),
        cleanup_timeout: Duration::from_secs(1),
        root_locator_resolver: Some(Arc::new(|session_id: &SessionId| {
            Ok(Some(ProviderThreadRef::new(format!(
                "fixture://root/{}",
                session_id.as_str()
            ))))
        })),
        ..ClaudeProviderConfig::default()
    })
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
    .expect("expected harness event was not emitted");
}

fn script(temp: &TempDir, name: &str, body: &str) -> PathBuf {
    let path = temp.path().join(name);
    fs::write(&path, body).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).unwrap();
    path
}
