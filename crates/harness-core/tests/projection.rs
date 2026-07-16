mod common;

use serde_json::json;
use vertebrae_harness_core::*;

use common::{event, outcome, text_event};

#[test]
fn gaps_are_reported_buffered_and_drained_contiguously() {
    let mut projection = HarnessProjection::new(4);
    let gap = projection
        .ingest(text_event("e3", "s", 3, "third"))
        .unwrap();
    assert_eq!(
        gap.diagnostics,
        vec![ProjectionDiagnostic::GapDetected {
            stream_id: StreamId::from("s"),
            expected: 1,
            received: 3,
        }]
    );
    assert_eq!(projection.buffered_len(&StreamId::from("s")), 1);

    let first = projection
        .ingest(text_event("e1", "s", 1, "first"))
        .unwrap();
    assert_eq!(first.applied_event_ids, vec![EventId::from("e1")]);

    let drain = projection
        .ingest(text_event("e2", "s", 2, "second"))
        .unwrap();
    assert_eq!(
        drain.applied_event_ids,
        vec![EventId::from("e2"), EventId::from("e3")]
    );
    let state = projection.stream(&StreamId::from("s")).unwrap();
    assert_eq!(state.next_sequence, 4);
    assert_eq!(
        state.turns[&TurnId::from("turn-s")].text,
        "firstsecondthird"
    );
    assert_eq!(projection.buffered_len(&StreamId::from("s")), 0);
}

#[test]
fn duplicate_ids_are_idempotent_and_timestamps_do_not_order_events() {
    let mut projection = HarnessProjection::new(2);
    let mut first = text_event("same", "s", 1, "one");
    first.timestamp = chrono::Utc::now();
    projection.ingest(first.clone()).unwrap();

    let duplicate = projection.ingest(first).unwrap();
    assert_eq!(
        duplicate.diagnostics,
        vec![ProjectionDiagnostic::DuplicateEventIgnored {
            event_id: EventId::from("same")
        }]
    );

    let mut second = text_event("second", "s", 2, "two");
    second.timestamp = chrono::DateTime::UNIX_EPOCH;
    projection.ingest(second).unwrap();
    assert_eq!(
        projection.stream(&StreamId::from("s")).unwrap().turns[&TurnId::from("turn-s")].text,
        "onetwo"
    );
}

#[test]
fn bounded_buffers_overflow_without_consuming_the_rejected_event() {
    let mut projection = HarnessProjection::new(1);
    projection
        .ingest(text_event("e3", "s", 3, "three"))
        .unwrap();
    assert_eq!(
        projection
            .ingest(text_event("e4", "s", 4, "four"))
            .unwrap_err(),
        ProjectionError::ProjectionOverflow {
            stream_id: StreamId::from("s"),
            capacity: 1,
        }
    );
    projection.ingest(text_event("e1", "s", 1, "one")).unwrap();
    projection.ingest(text_event("e2", "s", 2, "two")).unwrap();
    assert_eq!(
        projection
            .stream(&StreamId::from("s"))
            .unwrap()
            .next_sequence,
        4
    );
    let accepted = projection.ingest(text_event("e4", "s", 4, "four")).unwrap();
    assert_eq!(accepted.applied_event_ids, vec![EventId::from("e4")]);
}

#[test]
fn independent_streams_have_independent_sequence_origins() {
    let mut projection = HarnessProjection::new(2);
    projection.ingest(text_event("a1", "a", 1, "a")).unwrap();
    projection.ingest(text_event("b1", "b", 1, "b")).unwrap();
    assert_eq!(
        projection
            .stream(&StreamId::from("a"))
            .unwrap()
            .next_sequence,
        2
    );
    assert_eq!(
        projection
            .stream(&StreamId::from("b"))
            .unwrap()
            .next_sequence,
        2
    );
}

#[test]
fn usage_deltas_sum_while_session_snapshots_replace() {
    let usage = |id, sequence, input, context| {
        event(
            id,
            "s",
            sequence,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Usage(UsageEvent {
                turn_delta: Some(TurnUsage {
                    tokens: TokenUsage {
                        input_tokens: input,
                        ..TokenUsage::default()
                    },
                    cost_microusd: input,
                }),
                session_snapshot: Some(SessionUsage {
                    tokens: TokenUsage {
                        input_tokens: context,
                        ..TokenUsage::default()
                    },
                    cost_microusd: context,
                    context_tokens: Some(context),
                    context_window: Some(1_000),
                }),
            }),
        )
    };
    let mut projection = HarnessProjection::new(2);
    projection.ingest(usage("u1", 1, 2, 10)).unwrap();
    projection.ingest(usage("u2", 2, 3, 20)).unwrap();
    projection.ingest(usage("u2", 2, 3, 20)).unwrap();

    let state = projection.stream(&StreamId::from("s")).unwrap();
    assert_eq!(state.turn_usage_total.tokens.input_tokens, 5);
    assert_eq!(
        state.session_usage.as_ref().unwrap().context_tokens,
        Some(20)
    );
}

#[test]
fn tool_deltas_and_terminal_snapshots_reduce_deterministically() {
    let mut projection = HarnessProjection::new(2);
    projection
        .ingest(event(
            "t1",
            "s",
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                tool_call_id: ToolCallId::from("tool"),
                name: "shell".into(),
                input: json!({"cmd": "echo"}),
                status: ToolStatus::Started,
            }),
        ))
        .unwrap();
    projection
        .ingest(event(
            "t2",
            "s",
            2,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                tool_call_id: ToolCallId::from("tool"),
                output: json!("progress"),
                status: ToolStatus::Running,
                content_semantics: UpdateSemantics::Delta,
            }),
        ))
        .unwrap();
    projection
        .ingest(event(
            "t3",
            "s",
            3,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                tool_call_id: ToolCallId::from("tool"),
                output: json!("complete"),
                status: ToolStatus::Completed,
                content_semantics: UpdateSemantics::Snapshot,
            }),
        ))
        .unwrap();
    let tool = &projection.stream(&StreamId::from("s")).unwrap().tools[&ToolCallId::from("tool")];
    assert_eq!(tool.output_deltas, vec![json!("progress")]);
    assert_eq!(
        tool.output_snapshot.as_ref().unwrap().status,
        ToolStatus::Completed
    );
}

#[test]
fn every_terminal_tool_status_converges_for_live_and_replay() {
    for (index, status) in [
        ToolStatus::Completed,
        ToolStatus::Failed,
        ToolStatus::Declined,
        ToolStatus::Cancelled,
    ]
    .into_iter()
    .enumerate()
    {
        let stream = format!("tool-{index}");
        let events = vec![
            event(
                &format!("{stream}-1"),
                &stream,
                1,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                    tool_call_id: ToolCallId::from("tool"),
                    name: "test".into(),
                    input: json!({}),
                    status: ToolStatus::Started,
                }),
            ),
            event(
                &format!("{stream}-2"),
                &stream,
                2,
                UpdateSemantics::Delta,
                HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                    tool_call_id: ToolCallId::from("tool"),
                    output: json!("progress"),
                    status: ToolStatus::Running,
                    content_semantics: UpdateSemantics::Delta,
                }),
            ),
            event(
                &format!("{stream}-3"),
                &stream,
                3,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                    tool_call_id: ToolCallId::from("tool"),
                    output: json!("terminal"),
                    status,
                    content_semantics: UpdateSemantics::Snapshot,
                }),
            ),
        ];
        let mut live = HarnessProjection::new(3);
        for event in events.clone() {
            live.ingest(event).unwrap();
        }
        let mut replay = HarnessProjection::new(3);
        for position in [2, 0, 1] {
            replay.ingest(events[position].clone()).unwrap();
        }
        assert_eq!(live.streams(), replay.streams());
        assert_eq!(
            live.stream(&StreamId::from(stream.as_str())).unwrap().tools[&ToolCallId::from("tool")]
                .output_snapshot
                .as_ref()
                .unwrap()
                .status,
            status
        );
    }
}

#[test]
fn terminal_outcomes_controls_and_unknown_events_project_without_cross_talk() {
    let request = ControlRequestEnvelope {
        request_id: ControlRequestId::from("r"),
        session_id: Some(SessionId::from("session-s")),
        turn_id: Some(TurnId::from("turn-s")),
        request: ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::CommandExecution,
            title: "Run?".into(),
            details: None,
            modification_supported: true,
        }),
        timeout_ms: None,
        automatic_resolution: None,
    };
    let resolution = ControlResolution {
        request_id: request.request_id.clone(),
        source: ResolutionSource::Consumer,
        decision: Some(ControlDecision::Modified(json!({"cmd": "safe"}))),
        message: None,
    };
    let events = vec![
        event(
            "c1",
            "s",
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlRequested(request),
        ),
        event(
            "c2",
            "s",
            2,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlResolved(resolution),
        ),
        event(
            "x",
            "s",
            3,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Unknown {
                event_type: "future".into(),
                data: json!({"x": 1}),
            },
        ),
        event(
            "done",
            "s",
            4,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::TurnFinished(outcome(CompletionStatus::Interrupted)),
        ),
    ];
    let mut projection = HarnessProjection::new(2);
    for event in events {
        projection.ingest(event).unwrap();
    }
    let state = projection.stream(&StreamId::from("s")).unwrap();
    assert!(state.pending_controls.is_empty());
    assert_eq!(state.resolved_controls.len(), 1);
    assert_eq!(state.unknown_events.len(), 1);
    assert_eq!(state.turns[&TurnId::from("turn-s")].text, "");
    assert_eq!(
        state.turn_outcomes[&TurnId::from("turn-s")].status,
        CompletionStatus::Interrupted
    );
}

#[test]
fn session_end_and_turn_cancellation_settle_pending_controls() {
    let request_event = |id: &str, stream: &str, sequence: u64, turn: &str| {
        let mut event = event(
            id,
            stream,
            sequence,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlRequested(ControlRequestEnvelope {
                request_id: ControlRequestId::from(format!("request-{id}")),
                session_id: Some(SessionId::from(format!("session-{stream}"))),
                turn_id: Some(TurnId::from(turn)),
                request: ControlRequest::Approval(ApprovalRequest {
                    category: ApprovalCategory::AdditionalPermission,
                    title: "Grant?".into(),
                    details: None,
                    modification_supported: false,
                }),
                timeout_ms: Some(10),
                automatic_resolution: Some(ControlDecision::Deny),
            }),
        );
        event.correlation.turn_id = Some(TurnId::from(turn));
        event
    };

    let mut interrupted = HarnessProjection::new(2);
    interrupted
        .ingest(request_event("interrupt", "turn-stream", 1, "turn"))
        .unwrap();
    let mut finished = event(
        "finished",
        "turn-stream",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnFinished(outcome(CompletionStatus::Interrupted)),
    );
    finished.correlation.turn_id = Some(TurnId::from("turn"));
    interrupted.ingest(finished).unwrap();
    let state = interrupted.stream(&StreamId::from("turn-stream")).unwrap();
    assert!(state.pending_controls.is_empty());
    assert_eq!(
        state.resolved_controls[&ControlRequestId::from("request-interrupt")].source,
        ResolutionSource::Interrupted
    );

    for (index, (status, expected_source)) in [
        (SessionCloseStatus::Closed, ResolutionSource::Cancelled),
        (SessionCloseStatus::ProcessLost, ResolutionSource::Fallback),
        (SessionCloseStatus::Failed, ResolutionSource::Fallback),
    ]
    .into_iter()
    .enumerate()
    {
        let stream = format!("close-{index}");
        let request_id = ControlRequestId::from(format!("request-close-{index}"));
        let mut projection = HarnessProjection::new(2);
        projection
            .ingest(request_event(&format!("close-{index}"), &stream, 1, "turn"))
            .unwrap();
        projection
            .ingest(event(
                &format!("closed-{index}"),
                &stream,
                2,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::SessionClosed(SessionCloseOutcome {
                    status,
                    error: None,
                }),
            ))
            .unwrap();
        let state = projection.stream(&StreamId::from(stream.as_str())).unwrap();
        assert!(state.pending_controls.is_empty());
        let resolution = &state.resolved_controls[&request_id];
        assert_eq!(resolution.source, expected_source);
        assert_eq!(
            resolution.decision,
            Some(if status == SessionCloseStatus::Closed {
                ControlDecision::Cancel
            } else {
                ControlDecision::Deny
            })
        );
    }
}

#[test]
fn remaining_known_payloads_update_their_canonical_state() {
    let close = SessionCloseOutcome {
        status: SessionCloseStatus::Closed,
        error: None,
    };
    let run = RunOutcome {
        status: CompletionStatus::Failed,
        result_text: None,
        structured_output: None,
        usage: None,
        error: Some("failed".into()),
    };
    let events = vec![
        event(
            "session",
            "s",
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::SessionStarted(SessionStarted {
                provider: "mock".into(),
                model: Some("model".into()),
                provider_resume_id: Some(ProviderResumeId::from("resume")),
            }),
        ),
        event(
            "turn",
            "s",
            2,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::TurnStarted(TurnStarted {
                input_summary: Some("input".into()),
            }),
        ),
        event(
            "reasoning",
            "s",
            3,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Reasoning(ReasoningEvent {
                text: "thinking".into(),
            }),
        ),
        event(
            "file",
            "s",
            4,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::FileChange(FileChangeEvent {
                changes: vec![FileChange {
                    path: "new.rs".into(),
                    kind: FileChangeKind::Added,
                    previous_path: None,
                    patch: None,
                }],
            }),
        ),
        event(
            "warning",
            "s",
            5,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Warning(DiagnosticEvent {
                message: "careful".into(),
                code: None,
            }),
        ),
        event(
            "error",
            "s",
            6,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Error(DiagnosticEvent {
                message: "bad".into(),
                code: Some("E".into()),
            }),
        ),
        event(
            "close",
            "s",
            7,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::SessionClosed(close.clone()),
        ),
        event(
            "run",
            "s",
            8,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::RunFinished(run.clone()),
        ),
    ];
    let mut projection = HarnessProjection::new(2);
    for event in events {
        projection.ingest(event).unwrap();
    }
    let state = projection.stream(&StreamId::from("s")).unwrap();
    assert_eq!(state.session.as_ref().unwrap().provider, "mock");
    assert_eq!(
        state.provider_resume_id.as_ref().unwrap().as_str(),
        "resume"
    );
    assert_eq!(
        state.turns[&TurnId::from("turn-s")]
            .started
            .as_ref()
            .unwrap()
            .input_summary
            .as_deref(),
        Some("input")
    );
    assert_eq!(state.turns[&TurnId::from("turn-s")].reasoning, "thinking");
    assert_eq!(state.file_changes[0].path, "new.rs");
    assert_eq!(state.warnings[0].message, "careful");
    assert_eq!(state.errors[0].code.as_deref(), Some("E"));
    assert_eq!(state.session_close_outcome, Some(close));
    assert_eq!(state.run_outcome, Some(run));
}

#[test]
fn live_and_out_of_order_replay_converge_to_same_state() {
    let events = vec![
        text_event("e1", "s", 1, "a"),
        text_event("e2", "s", 2, "b"),
        event(
            "e3",
            "s",
            3,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Plan(PlanEvent {
                entries: vec![PlanEntry {
                    id: "p".into(),
                    text: "done".into(),
                    status: Some("completed".into()),
                }],
            }),
        ),
    ];
    let mut live = HarnessProjection::new(4);
    for event in events.clone() {
        live.ingest(event).unwrap();
    }
    let mut replay = HarnessProjection::new(4);
    for index in [2, 0, 1] {
        replay.ingest(events[index].clone()).unwrap();
    }
    assert_eq!(live.streams(), replay.streams());
}
