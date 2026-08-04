mod common;

use std::collections::BTreeSet;

use serde_json::json;
use vertebrae_harness_core::*;

use common::{event, outcome, text_event};

fn lineage_declaration_event(
    event_id: &str,
    stream_id: &str,
    session_id: &str,
    thread_id: &str,
    parent_thread_id: Option<&str>,
    kind: ThreadKind,
) -> HarnessEventV1 {
    let mut declaration = event(
        event_id,
        stream_id,
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: ThreadId::from(thread_id),
            parent_thread_id: parent_thread_id.map(ThreadId::from),
            kind,
            caused_by_tool_call_id: None,
            provider_thread_ref: None,
            agent_metadata: None,
        }),
    );
    declaration.correlation.session_id = Some(SessionId::from(session_id));
    declaration.correlation.thread_id = Some(ThreadId::from(thread_id));
    declaration.correlation.turn_id = None;
    declaration
}

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
fn compaction_lifecycle_is_projected_in_stream_order() {
    let mut projection = HarnessProjection::new(2);
    let active = event(
        "compact-active",
        "s",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Compaction(CompactionEvent {
            state: CompactionState::Active,
            trigger: Some("manual".into()),
            pre_tokens: None,
        }),
    );
    let completed = event(
        "compact-completed",
        "s",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Compaction(CompactionEvent {
            state: CompactionState::Completed,
            trigger: Some("manual".into()),
            pre_tokens: Some(42_000),
        }),
    );

    projection.ingest(active).unwrap();
    assert_eq!(
        projection.stream(&StreamId::from("s")).unwrap().compaction,
        Some(CompactionEvent {
            state: CompactionState::Active,
            trigger: Some("manual".into()),
            pre_tokens: None,
        })
    );
    projection.ingest(completed).unwrap();
    assert_eq!(
        projection.stream(&StreamId::from("s")).unwrap().compaction,
        Some(CompactionEvent {
            state: CompactionState::Completed,
            trigger: Some("manual".into()),
            pre_tokens: Some(42_000),
        })
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
        thread_id: Some(ThreadId::from("thread-s")),
        is_root: Some(true),
        request: ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::CommandExecution,
            title: "Run?".into(),
            details: None,
            modification_supported: true,
        }),
        presentation: None,
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
                thread_id: Some(ThreadId::from(format!("thread-{stream}"))),
                is_root: Some(true),
                request: ControlRequest::Approval(ApprovalRequest {
                    category: ApprovalCategory::AdditionalPermission,
                    title: "Grant?".into(),
                    details: None,
                    modification_supported: false,
                }),
                presentation: None,
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
fn duplicate_turn_lifecycle_events_cannot_replace_the_authoritative_lifecycle() {
    let mut projection = HarnessProjection::new(2);
    let mut started = event(
        "started",
        "turn-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnStarted(TurnStarted {
            input_summary: Some("accepted".into()),
        }),
    );
    started.correlation.turn_id = Some(TurnId::from("turn"));
    projection.ingest(started).unwrap();

    let mut duplicate_start = event(
        "duplicate-start",
        "turn-stream",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnStarted(TurnStarted {
            input_summary: Some("late duplicate".into()),
        }),
    );
    duplicate_start.correlation.turn_id = Some(TurnId::from("turn"));
    projection.ingest(duplicate_start).unwrap();

    let mut finished = event(
        "finished",
        "turn-stream",
        3,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnFinished(outcome(CompletionStatus::Completed)),
    );
    finished.correlation.turn_id = Some(TurnId::from("turn"));
    projection.ingest(finished).unwrap();

    let mut duplicate_finish = event(
        "duplicate-finish",
        "turn-stream",
        4,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnFinished(outcome(CompletionStatus::Failed)),
    );
    duplicate_finish.correlation.turn_id = Some(TurnId::from("turn"));
    let update = projection.ingest(duplicate_finish).unwrap();
    assert_eq!(
        update.applied_event_ids,
        vec![EventId::from("duplicate-finish")]
    );

    projection
        .ingest(event(
            "after-duplicate",
            "turn-stream",
            5,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Warning(DiagnosticEvent {
                message: "still projecting".into(),
                code: None,
            }),
        ))
        .unwrap();

    let state = projection.stream(&StreamId::from("turn-stream")).unwrap();
    assert_eq!(state.next_sequence, 6);
    assert_eq!(state.warnings[0].message, "still projecting");
    let turn = &state.turns[&TurnId::from("turn")];
    assert_eq!(
        turn.started.as_ref().unwrap().input_summary.as_deref(),
        Some("accepted")
    );
    assert_eq!(
        turn.outcome.as_ref().unwrap().status,
        CompletionStatus::Completed
    );
    assert_eq!(
        state.turn_outcomes[&TurnId::from("turn")].status,
        CompletionStatus::Completed
    );
}

#[test]
fn one_shot_run_correlation_settles_controls_without_double_counting_terminal_usage() {
    for (index, (status, expected_source, expected_decision)) in [
        (
            CompletionStatus::Completed,
            ResolutionSource::Cancelled,
            ControlDecision::Cancel,
        ),
        (
            CompletionStatus::Failed,
            ResolutionSource::Fallback,
            ControlDecision::Deny,
        ),
        (
            CompletionStatus::Interrupted,
            ResolutionSource::Interrupted,
            ControlDecision::Cancel,
        ),
        (
            CompletionStatus::Cancelled,
            ResolutionSource::Cancelled,
            ControlDecision::Cancel,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let stream = format!("run-{index}");
        let run_id = RunId::from(format!("run-id-{index}"));
        let request_id = ControlRequestId::from(format!("run-control-{index}"));
        let mut input = event(
            &format!("run-input-{index}"),
            &stream,
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::TurnInput(TurnInput {
                thread_id: ThreadId::from(format!("thread-{stream}")),
                run_id: Some(run_id.clone()),
                content: "exact one-shot prompt\nwith a second line".into(),
                provenance: TurnInputProvenance::Human,
            }),
        );
        input.correlation.session_id = None;
        input.correlation.run_id = Some(run_id.clone());
        input.correlation.turn_id = None;

        let mut requested = event(
            &format!("run-request-{index}"),
            &stream,
            2,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlRequested(ControlRequestEnvelope {
                request_id: request_id.clone(),
                session_id: None,
                turn_id: None,
                thread_id: None,
                is_root: None,
                request: ControlRequest::Approval(ApprovalRequest {
                    category: ApprovalCategory::CommandExecution,
                    title: "Run command?".into(),
                    details: None,
                    modification_supported: false,
                }),
                presentation: None,
                timeout_ms: None,
                automatic_resolution: Some(ControlDecision::Deny),
            }),
        );
        requested.correlation.session_id = None;
        requested.correlation.run_id = Some(run_id.clone());
        requested.correlation.turn_id = None;

        let mut usage = event(
            &format!("run-usage-{index}"),
            &stream,
            3,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::Usage(UsageEvent {
                turn_delta: Some(TurnUsage {
                    tokens: TokenUsage {
                        input_tokens: 5,
                        ..TokenUsage::default()
                    },
                    cost_microusd: 7,
                }),
                session_snapshot: None,
            }),
        );
        usage.correlation.session_id = None;
        usage.correlation.run_id = Some(run_id.clone());
        usage.correlation.turn_id = None;

        let outcome = RunOutcome {
            status,
            result_text: None,
            structured_output: None,
            usage: Some(TurnUsage {
                tokens: TokenUsage {
                    input_tokens: 999,
                    ..TokenUsage::default()
                },
                cost_microusd: 999,
            }),
            metrics: OutcomeMetrics::default(),
            error: None,
        };
        let mut finished = event(
            &format!("run-finished-{index}"),
            &stream,
            4,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::RunFinished(outcome.clone()),
        );
        finished.correlation.session_id = None;
        finished.correlation.run_id = Some(run_id.clone());
        finished.correlation.turn_id = None;

        let mut projection = HarnessProjection::new(2);
        for event in [input, requested, usage, finished] {
            projection.ingest(event).unwrap();
        }

        let state = projection.stream(&StreamId::from(stream)).unwrap();
        assert_eq!(state.turn_inputs[0].provenance, TurnInputProvenance::Human);
        assert!(state.pending_controls.is_empty());
        assert_eq!(state.resolved_controls[&request_id].source, expected_source);
        assert_eq!(
            state.resolved_controls[&request_id].decision,
            Some(expected_decision)
        );
        assert_eq!(state.run_outcomes[&run_id], outcome);
        assert_eq!(state.turn_usage_total.tokens.input_tokens, 5);
        assert_eq!(state.turn_usage_total.cost_microusd, 7);
    }
}

#[test]
fn thread_catalog_projects_lineage_and_multiple_delivery_streams_without_nesting_events() {
    let session_id = SessionId::from("durable-session");
    let root_id = ThreadId::from("root-thread");
    let child_id = ThreadId::from("child-thread");
    let grandchild_id = ThreadId::from("grandchild-thread");

    let declaration_event = |event_id: &str,
                             stream: &str,
                             thread_id: &ThreadId,
                             parent_thread_id: Option<ThreadId>,
                             kind: ThreadKind,
                             caused_by: Option<&str>,
                             provider_ref: &str| {
        let mut event = event(
            event_id,
            stream,
            1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                thread_id: thread_id.clone(),
                parent_thread_id,
                kind,
                caused_by_tool_call_id: caused_by.map(ToolCallId::from),
                provider_thread_ref: Some(ProviderThreadRef::from(provider_ref)),
                agent_metadata: (kind == ThreadKind::Subagent).then(|| AgentMetadata {
                    name: Some(format!("agent-{thread_id}")),
                    role: Some("delegated worker".into()),
                    model: None,
                }),
            }),
        );
        event.correlation.session_id = Some(session_id.clone());
        event.correlation.thread_id = Some(thread_id.clone());
        event.correlation.turn_id = None;
        event
    };

    let root = declaration_event(
        "root-declared",
        "root-stream-1",
        &root_id,
        None,
        ThreadKind::Root,
        None,
        "codex-thread://opaque/root?cursor=1",
    );
    let child = declaration_event(
        "child-declared",
        "child-stream",
        &child_id,
        Some(root_id.clone()),
        ThreadKind::Subagent,
        Some("spawn-child"),
        "claude-transcript://opaque/child.jsonl",
    );
    let grandchild = declaration_event(
        "grandchild-declared",
        "grandchild-stream",
        &grandchild_id,
        Some(child_id.clone()),
        ThreadKind::Subagent,
        Some("spawn-grandchild"),
        "provider-owned:grandchild:locator",
    );

    let mut child_instruction = event(
        "child-instruction",
        "child-stream",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: child_id.clone(),
            run_id: None,
            content: "Inspect the projection contract exactly as supplied.".into(),
            provenance: TurnInputProvenance::Agent,
        }),
    );
    child_instruction.correlation.session_id = Some(session_id.clone());
    child_instruction.correlation.thread_id = Some(child_id.clone());
    child_instruction.correlation.turn_id = Some(TurnId::from("child-turn"));

    // A resumed delivery gets a fresh stream and sequence origin while retaining
    // the same logical session and thread identities.
    let mut resumed_root_input = event(
        "resumed-root-input",
        "root-stream-2",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: root_id.clone(),
            run_id: None,
            content: "Continue the same logical conversation.".into(),
            provenance: TurnInputProvenance::Human,
        }),
    );
    resumed_root_input.correlation.session_id = Some(session_id.clone());
    resumed_root_input.correlation.thread_id = Some(root_id.clone());
    resumed_root_input.correlation.turn_id = Some(TurnId::from("root-resumed-turn"));

    let mut projection = HarnessProjection::new(4);
    for event in [
        grandchild,
        resumed_root_input,
        child_instruction,
        root,
        child,
    ] {
        projection.ingest(event).unwrap();
    }

    assert_eq!(projection.threads().len(), 3);
    let root = projection.thread(&root_id).unwrap();
    assert_eq!(root.session_id.as_ref(), Some(&session_id));
    assert_eq!(
        root.stream_ids,
        BTreeSet::from([
            StreamId::from("root-stream-1"),
            StreamId::from("root-stream-2"),
        ])
    );
    assert_eq!(
        root.declaration
            .as_ref()
            .unwrap()
            .provider_thread_ref
            .as_ref()
            .unwrap()
            .as_str(),
        "codex-thread://opaque/root?cursor=1"
    );

    let child = projection.thread(&child_id).unwrap();
    assert_eq!(
        child
            .declaration
            .as_ref()
            .unwrap()
            .parent_thread_id
            .as_ref(),
        Some(&root_id)
    );
    assert_eq!(
        child
            .declaration
            .as_ref()
            .unwrap()
            .caused_by_tool_call_id
            .as_ref()
            .unwrap()
            .as_str(),
        "spawn-child"
    );
    assert_eq!(
        projection
            .thread(&grandchild_id)
            .unwrap()
            .declaration
            .as_ref()
            .unwrap()
            .parent_thread_id,
        Some(child_id)
    );

    let child_stream = projection.stream(&StreamId::from("child-stream")).unwrap();
    assert_eq!(
        child_stream.turns[&TurnId::from("child-turn")].inputs[0].provenance,
        TurnInputProvenance::Agent
    );
    assert!(
        projection
            .stream(&StreamId::from("root-stream-1"))
            .unwrap()
            .turns
            .is_empty()
    );
    assert_eq!(
        projection
            .stream(&StreamId::from("root-stream-2"))
            .unwrap()
            .next_sequence,
        2
    );
}

#[test]
fn stream_identity_conflicts_are_diagnosed_and_excluded_from_canonical_state() {
    let mut first = event(
        "identity-first",
        "identity-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: ThreadId::from("thread-one"),
            run_id: None,
            content: "first".into(),
            provenance: TurnInputProvenance::Human,
        }),
    );
    first.correlation.session_id = Some(SessionId::from("session-one"));
    first.correlation.thread_id = Some(ThreadId::from("thread-one"));

    let mut wrong_session = text_event("wrong-session", "identity-stream", 2, "bad-session");
    wrong_session.correlation.session_id = Some(SessionId::from("session-two"));
    wrong_session.correlation.thread_id = Some(ThreadId::from("thread-one"));

    let mut wrong_thread = text_event("wrong-thread", "identity-stream", 3, "bad-thread");
    wrong_thread.correlation.session_id = Some(SessionId::from("session-one"));
    wrong_thread.correlation.thread_id = Some(ThreadId::from("thread-two"));

    let mut valid = text_event("identity-valid", "identity-stream", 4, "valid");
    valid.correlation.session_id = Some(SessionId::from("session-one"));
    valid.correlation.thread_id = Some(ThreadId::from("thread-one"));

    let mut projection = HarnessProjection::new(2);
    projection.ingest(first).unwrap();
    let session_update = projection.ingest(wrong_session).unwrap();
    let thread_update = projection.ingest(wrong_thread).unwrap();
    projection.ingest(valid).unwrap();

    assert_eq!(
        session_update.diagnostics,
        vec![
            ProjectionDiagnostic::StreamSessionConflict {
                event_id: EventId::from("wrong-session"),
                stream_id: StreamId::from("identity-stream"),
                expected: SessionId::from("session-one"),
                received: SessionId::from("session-two"),
            },
            ProjectionDiagnostic::ThreadSessionConflict {
                event_id: EventId::from("wrong-session"),
                thread_id: ThreadId::from("thread-one"),
                expected: SessionId::from("session-one"),
                received: SessionId::from("session-two"),
            },
        ]
    );
    assert_eq!(
        session_update.ignored_event_ids,
        vec![EventId::from("wrong-session")]
    );
    assert_eq!(
        thread_update.diagnostics,
        vec![ProjectionDiagnostic::StreamThreadConflict {
            event_id: EventId::from("wrong-thread"),
            stream_id: StreamId::from("identity-stream"),
            expected: ThreadId::from("thread-one"),
            received: ThreadId::from("thread-two"),
        }]
    );

    let stream = projection
        .stream(&StreamId::from("identity-stream"))
        .unwrap();
    assert_eq!(stream.session_id, Some(SessionId::from("session-one")));
    assert_eq!(stream.thread_id, Some(ThreadId::from("thread-one")));
    assert_eq!(
        stream.turns[&TurnId::from("turn-identity-stream")].text,
        "valid"
    );
    assert!(projection.thread(&ThreadId::from("thread-two")).is_none());
}

#[test]
fn conflicting_run_cannot_settle_controls_owned_by_the_stream_run() {
    let stream_id = "run-binding-stream";
    let run_id = RunId::from("bound-run");
    let request_id = ControlRequestId::from("bound-control");
    let mut input = event(
        "bound-input",
        stream_id,
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: ThreadId::from("run-thread"),
            run_id: Some(run_id.clone()),
            content: "run".into(),
            provenance: TurnInputProvenance::Human,
        }),
    );
    input.correlation.session_id = None;
    input.correlation.thread_id = Some(ThreadId::from("run-thread"));
    input.correlation.run_id = Some(run_id.clone());
    input.correlation.turn_id = None;

    let mut requested = event(
        "bound-request",
        stream_id,
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ControlRequested(ControlRequestEnvelope {
            request_id: request_id.clone(),
            session_id: None,
            turn_id: None,
            thread_id: None,
            is_root: None,
            request: ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::CommandExecution,
                title: "approve".into(),
                details: None,
                modification_supported: false,
            }),
            presentation: None,
            timeout_ms: None,
            automatic_resolution: Some(ControlDecision::Deny),
        }),
    );
    requested.correlation.session_id = None;
    requested.correlation.thread_id = Some(ThreadId::from("run-thread"));
    requested.correlation.run_id = Some(run_id.clone());
    requested.correlation.turn_id = None;

    let outcome = RunOutcome {
        status: CompletionStatus::Completed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: None,
    };
    let mut wrong_run_finished = event(
        "wrong-run-finished",
        stream_id,
        3,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::RunFinished(outcome.clone()),
    );
    wrong_run_finished.correlation.session_id = None;
    wrong_run_finished.correlation.thread_id = Some(ThreadId::from("run-thread"));
    wrong_run_finished.correlation.run_id = Some(RunId::from("other-run"));
    wrong_run_finished.correlation.turn_id = None;

    let mut correct_run_finished = event(
        "bound-run-finished",
        stream_id,
        4,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::RunFinished(outcome.clone()),
    );
    correct_run_finished.correlation.session_id = None;
    correct_run_finished.correlation.thread_id = Some(ThreadId::from("run-thread"));
    correct_run_finished.correlation.run_id = Some(run_id.clone());
    correct_run_finished.correlation.turn_id = None;

    let mut projection = HarnessProjection::new(2);
    projection.ingest(input).unwrap();
    projection.ingest(requested).unwrap();
    let conflict = projection.ingest(wrong_run_finished).unwrap();
    let state = projection.stream(&StreamId::from(stream_id)).unwrap();
    assert!(state.pending_controls.contains_key(&request_id));
    assert!(state.run_outcomes.is_empty());
    assert_eq!(
        conflict.diagnostics,
        vec![ProjectionDiagnostic::StreamRunConflict {
            event_id: EventId::from("wrong-run-finished"),
            stream_id: StreamId::from(stream_id),
            expected: run_id.clone(),
            received: Some(RunId::from("other-run")),
        }]
    );

    projection.ingest(correct_run_finished).unwrap();
    let state = projection.stream(&StreamId::from(stream_id)).unwrap();
    assert!(state.pending_controls.is_empty());
    assert_eq!(state.run_outcomes[&run_id], outcome);
    assert_eq!(state.run_id, Some(run_id));
}

#[test]
fn turn_input_payload_identity_is_canonical_and_disagreement_is_ignored() {
    let mut event = event(
        "input-correlation-conflict",
        "input-conflict-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: ThreadId::from("payload-thread"),
            run_id: Some(RunId::from("payload-run")),
            content: "must not project".into(),
            provenance: TurnInputProvenance::Provider,
        }),
    );
    event.correlation.session_id = None;
    event.correlation.thread_id = Some(ThreadId::from("routing-thread"));
    event.correlation.run_id = Some(RunId::from("routing-run"));
    event.correlation.turn_id = None;

    let mut projection = HarnessProjection::new(2);
    let update = projection.ingest(event).unwrap();
    assert_eq!(
        update.diagnostics,
        vec![
            ProjectionDiagnostic::TurnInputThreadCorrelationConflict {
                event_id: EventId::from("input-correlation-conflict"),
                payload_thread_id: ThreadId::from("payload-thread"),
                correlation_thread_id: ThreadId::from("routing-thread"),
            },
            ProjectionDiagnostic::TurnInputRunCorrelationConflict {
                event_id: EventId::from("input-correlation-conflict"),
                payload_run_id: Some(RunId::from("payload-run")),
                correlation_run_id: RunId::from("routing-run"),
            },
        ]
    );
    assert_eq!(
        update.ignored_event_ids,
        vec![EventId::from("input-correlation-conflict")]
    );
    let stream = projection
        .stream(&StreamId::from("input-conflict-stream"))
        .unwrap();
    assert!(stream.thread_id.is_none());
    assert!(stream.run_id.is_none());
    assert!(stream.turn_inputs.is_empty());
}

#[test]
fn invalid_and_conflicting_thread_declarations_retain_the_first_valid_catalog_entry() {
    let original_declaration = ThreadDeclared {
        thread_id: ThreadId::from("stable-thread"),
        parent_thread_id: None,
        kind: ThreadKind::Root,
        caused_by_tool_call_id: None,
        provider_thread_ref: Some(ProviderThreadRef::from("opaque:first")),
        agent_metadata: None,
    };
    let mut original = event(
        "stable-declaration",
        "declaration-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(original_declaration.clone()),
    );
    original.correlation.session_id = Some(SessionId::from("stable-session"));
    original.correlation.thread_id = Some(ThreadId::from("stable-thread"));
    original.correlation.turn_id = None;

    let mut conflicting = event(
        "conflicting-declaration",
        "declaration-stream",
        2,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            provider_thread_ref: Some(ProviderThreadRef::from("opaque:replacement")),
            ..original_declaration.clone()
        }),
    );
    conflicting.correlation.session_id = Some(SessionId::from("stable-session"));
    conflicting.correlation.thread_id = Some(ThreadId::from("stable-thread"));
    conflicting.correlation.turn_id = None;

    let mut wrong_session = event(
        "wrong-session-declaration",
        "other-declaration-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(original_declaration.clone()),
    );
    wrong_session.correlation.session_id = Some(SessionId::from("other-session"));
    wrong_session.correlation.thread_id = Some(ThreadId::from("stable-thread"));
    wrong_session.correlation.turn_id = None;

    let mut malformed_root = event(
        "malformed-root",
        "malformed-root-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: ThreadId::from("malformed-root-thread"),
            parent_thread_id: Some(ThreadId::from("impossible-parent")),
            kind: ThreadKind::Root,
            caused_by_tool_call_id: Some(ToolCallId::from("impossible-cause")),
            provider_thread_ref: None,
            agent_metadata: None,
        }),
    );
    malformed_root.correlation.thread_id = Some(ThreadId::from("malformed-root-thread"));
    malformed_root.correlation.turn_id = None;

    let mut malformed_subagent = event(
        "malformed-subagent",
        "malformed-subagent-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: ThreadId::from("orphan-subagent"),
            parent_thread_id: None,
            kind: ThreadKind::Subagent,
            caused_by_tool_call_id: Some(ToolCallId::from("spawn")),
            provider_thread_ref: None,
            agent_metadata: None,
        }),
    );
    malformed_subagent.correlation.thread_id = Some(ThreadId::from("orphan-subagent"));
    malformed_subagent.correlation.turn_id = None;

    let mut mismatched = event(
        "mismatched-declaration",
        "mismatched-declaration-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: ThreadId::from("payload-declaration-thread"),
            parent_thread_id: None,
            kind: ThreadKind::Root,
            caused_by_tool_call_id: None,
            provider_thread_ref: None,
            agent_metadata: None,
        }),
    );
    mismatched.correlation.thread_id = Some(ThreadId::from("routing-declaration-thread"));
    mismatched.correlation.turn_id = None;

    let mut projection = HarnessProjection::new(2);
    projection.ingest(original).unwrap();
    let declaration_conflict = projection.ingest(conflicting).unwrap();
    let session_conflict = projection.ingest(wrong_session).unwrap();
    let malformed_root_update = projection.ingest(malformed_root).unwrap();
    let malformed_subagent_update = projection.ingest(malformed_subagent).unwrap();
    let mismatch_update = projection.ingest(mismatched).unwrap();

    assert!(declaration_conflict.diagnostics.contains(
        &ProjectionDiagnostic::ThreadDeclarationConflict {
            event_id: EventId::from("conflicting-declaration"),
            thread_id: ThreadId::from("stable-thread"),
        }
    ));
    assert!(
        session_conflict
            .diagnostics
            .contains(&ProjectionDiagnostic::ThreadSessionConflict {
                event_id: EventId::from("wrong-session-declaration"),
                thread_id: ThreadId::from("stable-thread"),
                expected: SessionId::from("stable-session"),
                received: SessionId::from("other-session"),
            })
    );
    assert_eq!(
        malformed_root_update.diagnostics,
        vec![
            ProjectionDiagnostic::InvalidThreadDeclaration {
                event_id: EventId::from("malformed-root"),
                thread_id: ThreadId::from("malformed-root-thread"),
                violation: ThreadDeclarationViolation::RootHasParent,
            },
            ProjectionDiagnostic::InvalidThreadDeclaration {
                event_id: EventId::from("malformed-root"),
                thread_id: ThreadId::from("malformed-root-thread"),
                violation: ThreadDeclarationViolation::RootHasCausingToolCall,
            },
        ]
    );
    assert_eq!(
        malformed_subagent_update.diagnostics,
        vec![ProjectionDiagnostic::InvalidThreadDeclaration {
            event_id: EventId::from("malformed-subagent"),
            thread_id: ThreadId::from("orphan-subagent"),
            violation: ThreadDeclarationViolation::SubagentMissingParent,
        }]
    );
    assert_eq!(
        mismatch_update.diagnostics,
        vec![ProjectionDiagnostic::ThreadDeclaredCorrelationConflict {
            event_id: EventId::from("mismatched-declaration"),
            payload_thread_id: ThreadId::from("payload-declaration-thread"),
            correlation_thread_id: ThreadId::from("routing-declaration-thread"),
        }]
    );

    let catalog = projection.thread(&ThreadId::from("stable-thread")).unwrap();
    assert_eq!(catalog.declaration, Some(original_declaration));
    assert_eq!(
        catalog.stream_ids,
        BTreeSet::from([StreamId::from("declaration-stream")])
    );
    assert!(
        projection
            .thread(&ThreadId::from("malformed-root-thread"))
            .is_none()
    );
    assert!(
        projection
            .thread(&ThreadId::from("orphan-subagent"))
            .is_none()
    );
    assert!(
        projection
            .thread(&ThreadId::from("payload-declaration-thread"))
            .is_none()
    );
}

#[test]
fn self_parenting_and_longer_lineage_cycles_are_diagnosed_on_the_revealing_declaration() {
    let self_parent = lineage_declaration_event(
        "self-parent",
        "self-parent-stream",
        "cycle-session",
        "self",
        Some("self"),
        ThreadKind::Subagent,
    );
    let a_to_b = lineage_declaration_event(
        "a-to-b",
        "a-stream",
        "cycle-session",
        "a",
        Some("b"),
        ThreadKind::Subagent,
    );
    let b_to_a = lineage_declaration_event(
        "b-to-a",
        "b-stream",
        "cycle-session",
        "b",
        Some("a"),
        ThreadKind::Subagent,
    );

    let mut projection = HarnessProjection::new(2);
    let self_update = projection.ingest(self_parent).unwrap();
    projection.ingest(a_to_b).unwrap();
    let cycle_update = projection.ingest(b_to_a).unwrap();

    assert_eq!(
        self_update.diagnostics,
        vec![ProjectionDiagnostic::InvalidThreadDeclaration {
            event_id: EventId::from("self-parent"),
            thread_id: ThreadId::from("self"),
            violation: ThreadDeclarationViolation::SelfParent,
        }]
    );
    assert_eq!(
        cycle_update.diagnostics,
        vec![ProjectionDiagnostic::InvalidThreadDeclaration {
            event_id: EventId::from("b-to-a"),
            thread_id: ThreadId::from("b"),
            violation: ThreadDeclarationViolation::LineageCycle,
        }]
    );
    assert!(projection.thread(&ThreadId::from("self")).is_none());
    assert!(projection.thread(&ThreadId::from("a")).is_some());
    assert!(projection.thread(&ThreadId::from("b")).is_none());
}

#[test]
fn parent_child_sessions_are_checked_in_both_arrival_orders_without_rejecting_valid_child_first() {
    let parent_first = lineage_declaration_event(
        "parent-first",
        "parent-first-stream",
        "session-one",
        "parent-first-thread",
        None,
        ThreadKind::Root,
    );
    let conflicting_child = lineage_declaration_event(
        "conflicting-child",
        "conflicting-child-stream",
        "session-two",
        "conflicting-child-thread",
        Some("parent-first-thread"),
        ThreadKind::Subagent,
    );
    let child_first = lineage_declaration_event(
        "child-first",
        "child-first-stream",
        "session-two",
        "child-first-thread",
        Some("late-parent-thread"),
        ThreadKind::Subagent,
    );
    let conflicting_late_parent = lineage_declaration_event(
        "conflicting-late-parent",
        "conflicting-late-parent-stream",
        "session-one",
        "late-parent-thread",
        None,
        ThreadKind::Root,
    );
    let valid_child_first = lineage_declaration_event(
        "valid-child-first",
        "valid-child-first-stream",
        "session-one",
        "valid-child-thread",
        Some("valid-late-parent-thread"),
        ThreadKind::Subagent,
    );
    let valid_late_parent = lineage_declaration_event(
        "valid-late-parent",
        "valid-late-parent-stream",
        "session-one",
        "valid-late-parent-thread",
        None,
        ThreadKind::Root,
    );

    let mut projection = HarnessProjection::new(2);
    projection.ingest(parent_first).unwrap();
    let parent_first_conflict = projection.ingest(conflicting_child).unwrap();
    projection.ingest(child_first).unwrap();
    let child_first_conflict = projection.ingest(conflicting_late_parent).unwrap();
    projection.ingest(valid_child_first).unwrap();
    let valid_parent_update = projection.ingest(valid_late_parent).unwrap();

    assert_eq!(
        parent_first_conflict.diagnostics,
        vec![ProjectionDiagnostic::ThreadLineageSessionConflict {
            event_id: EventId::from("conflicting-child"),
            parent_thread_id: ThreadId::from("parent-first-thread"),
            child_thread_id: ThreadId::from("conflicting-child-thread"),
            parent_session_id: SessionId::from("session-one"),
            child_session_id: SessionId::from("session-two"),
        }]
    );
    assert_eq!(
        child_first_conflict.diagnostics,
        vec![ProjectionDiagnostic::ThreadLineageSessionConflict {
            event_id: EventId::from("conflicting-late-parent"),
            parent_thread_id: ThreadId::from("late-parent-thread"),
            child_thread_id: ThreadId::from("child-first-thread"),
            parent_session_id: SessionId::from("session-one"),
            child_session_id: SessionId::from("session-two"),
        }]
    );
    assert!(valid_parent_update.diagnostics.is_empty());
    assert!(
        projection
            .thread(&ThreadId::from("conflicting-child-thread"))
            .is_none()
    );
    assert!(
        projection
            .thread(&ThreadId::from("late-parent-thread"))
            .is_none()
    );
    assert!(
        projection
            .thread(&ThreadId::from("child-first-thread"))
            .is_some()
    );
    assert!(
        projection
            .thread(&ThreadId::from("valid-child-thread"))
            .is_some()
    );
    assert!(
        projection
            .thread(&ThreadId::from("valid-late-parent-thread"))
            .is_some()
    );
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
        metrics: OutcomeMetrics::default(),
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
                tools: Vec::new(),
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
                tool_call_id: Some(ToolCallId::from("file")),
                changes: vec![FileChange {
                    path: "new.rs".into(),
                    kind: FileChangeKind::Added,
                    previous_path: None,
                    patch: None,
                }],
                status: ToolStatus::Completed,
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
