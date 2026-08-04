mod common;

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;
use vertebrae_harness_core::*;

use common::{event, outcome};

/// Exact pre-change V1 wire reader shape: it has neither thread/run
/// correlation fields nor knowledge of the additive `turn_input` event type.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct LegacyEventCorrelation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    item_id: Option<ItemId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_tool_call_id: Option<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_resume_id: Option<ProviderResumeId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct LegacyWireEventV1 {
    version: u8,
    event_id: EventId,
    stream_id: StreamId,
    sequence: u64,
    #[serde(default)]
    correlation: LegacyEventCorrelation,
    timestamp: DateTime<Utc>,
    semantics: UpdateSemantics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_sequence: Option<u64>,
    #[serde(rename = "type")]
    event_type: String,
    data: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum LegacyPayloadV1 {
    Unknown { event_type: String, data: Value },
}

impl LegacyWireEventV1 {
    fn payload(&self) -> LegacyPayloadV1 {
        LegacyPayloadV1::Unknown {
            event_type: self.event_type.clone(),
            data: self.data.clone(),
        }
    }
}

fn control_request() -> ControlRequestEnvelope {
    ControlRequestEnvelope {
        request_id: ControlRequestId::from("control-1"),
        session_id: Some(SessionId::from("session-s")),
        turn_id: Some(TurnId::from("turn-s")),
        thread_id: Some(ThreadId::from("thread-s")),
        is_root: Some(true),
        request: ControlRequest::UserQuestion {
            questions: vec![UserQuestion {
                id: "q1".into(),
                prompt: "Choose".into(),
                header: None,
                options: vec![QuestionOption {
                    id: "a".into(),
                    label: "A".into(),
                    description: None,
                }],
                multiple: true,
                free_form: true,
            }],
        },
        presentation: Some(ControlPresentation {
            tool_name: Some("AskUserQuestion".into()),
            tool_call_id: Some(ToolCallId::from("tool-question")),
            input: Some(json!({"questions": []})),
            message: Some("Answer a question".into()),
        }),
        timeout_ms: Some(1_000),
        automatic_resolution: Some(ControlDecision::Deny),
    }
}

#[test]
fn control_request_thread_classification_is_backward_compatible() {
    let mut value = serde_json::to_value(control_request()).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("thread_id");
    object.remove("is_root");

    let decoded: ControlRequestEnvelope = serde_json::from_value(value).unwrap();

    assert_eq!(decoded.thread_id, None);
    assert_eq!(decoded.is_root, None);
}

#[test]
fn every_v1_payload_round_trips_through_type_and_data_wire_shape() {
    let turn_outcome = outcome(CompletionStatus::Completed);
    let run_outcome = RunOutcome {
        status: CompletionStatus::Cancelled,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics {
            duration_ms: Some(123),
            turn_count: Some(4),
            context_tokens: Some(0),
            context_window: Some(200_000),
            total_cost_usd: Some(0.42),
        },
        error: Some("cancelled".into()),
    };
    let close_outcome = SessionCloseOutcome {
        status: SessionCloseStatus::ProcessLost,
        error: Some("gone".into()),
    };
    let request = control_request();
    let payloads = vec![
        HarnessEventPayloadV1::SessionStarted(SessionStarted {
            provider: "test".into(),
            model: Some("model".into()),
            provider_resume_id: Some(ProviderResumeId::from("resume")),
            tools: vec!["Read".into(), "Bash".into()],
        }),
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: ThreadId::from("thread-s"),
            parent_thread_id: None,
            kind: ThreadKind::Root,
            caused_by_tool_call_id: None,
            provider_thread_ref: Some(ProviderThreadRef::from("opaque://root/transcript")),
            agent_metadata: Some(AgentMetadata {
                name: Some("primary".into()),
                role: Some("implementer".into()),
                model: Some("model".into()),
            }),
        }),
        HarnessEventPayloadV1::TurnStarted(TurnStarted {
            input_summary: Some("hello".into()),
        }),
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: ThreadId::from("thread-s"),
            run_id: None,
            content: "hello\nwithout truncation".into(),
            provenance: TurnInputProvenance::Human,
        }),
        HarnessEventPayloadV1::Text(TextEvent { text: "hi".into() }),
        HarnessEventPayloadV1::Reasoning(ReasoningEvent {
            text: "think".into(),
        }),
        HarnessEventPayloadV1::Plan(PlanEvent {
            entries: vec![PlanEntry {
                id: "p1".into(),
                text: "work".into(),
                status: Some("pending".into()),
            }],
        }),
        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
            tool_call_id: ToolCallId::from("tool"),
            name: "shell".into(),
            input: json!({"cmd": "true"}),
            status: ToolStatus::Started,
        }),
        HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
            tool_call_id: ToolCallId::from("tool"),
            output: json!("ok"),
            status: ToolStatus::Completed,
            content_semantics: UpdateSemantics::Snapshot,
        }),
        HarnessEventPayloadV1::FileChange(FileChangeEvent {
            tool_call_id: Some(ToolCallId::from("file-tool")),
            changes: vec![FileChange {
                path: "src/lib.rs".into(),
                kind: FileChangeKind::Modified,
                previous_path: None,
                patch: Some("+line".into()),
            }],
            status: ToolStatus::Completed,
        }),
        HarnessEventPayloadV1::Usage(UsageEvent {
            turn_delta: turn_outcome.usage.clone(),
            session_snapshot: Some(SessionUsage {
                tokens: TokenUsage::default(),
                cost_microusd: 7,
                context_tokens: Some(10),
                context_window: Some(100),
            }),
        }),
        HarnessEventPayloadV1::Warning(DiagnosticEvent {
            message: "warning".into(),
            code: Some("W1".into()),
        }),
        HarnessEventPayloadV1::Error(DiagnosticEvent {
            message: "error".into(),
            code: Some("E1".into()),
        }),
        HarnessEventPayloadV1::Compaction(CompactionEvent {
            state: CompactionState::Active,
            trigger: Some("manual".into()),
            pre_tokens: None,
        }),
        HarnessEventPayloadV1::Compaction(CompactionEvent {
            state: CompactionState::Completed,
            trigger: Some("auto".into()),
            pre_tokens: Some(123_456),
        }),
        HarnessEventPayloadV1::Compaction(CompactionEvent {
            state: CompactionState::Cleared,
            trigger: None,
            pre_tokens: None,
        }),
        HarnessEventPayloadV1::ControlRequested(request.clone()),
        HarnessEventPayloadV1::ControlResolved(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Timeout,
            decision: Some(ControlDecision::Deny),
            message: None,
        }),
        HarnessEventPayloadV1::TurnFinished(turn_outcome),
        HarnessEventPayloadV1::SessionClosed(close_outcome),
        HarnessEventPayloadV1::RunFinished(run_outcome),
    ];

    for (index, payload) in payloads.into_iter().enumerate() {
        let original = event(
            &format!("event-{index}"),
            "s",
            index as u64 + 1,
            UpdateSemantics::Snapshot,
            payload,
        );
        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["type"], original.payload.event_type());
        assert!(json.get("data").is_some());
        assert_eq!(
            serde_json::from_value::<HarnessEventV1>(json).unwrap(),
            original
        );
    }
}

#[test]
fn turn_input_is_lossless_and_preserves_authorship_and_run_thread_correlation() {
    for (index, provenance) in [
        TurnInputProvenance::Human,
        TurnInputProvenance::Agent,
        TurnInputProvenance::System,
        TurnInputProvenance::Provider,
    ]
    .into_iter()
    .enumerate()
    {
        let content = format!("line one\nline two 🦴 {{\"source\":{index}}}");
        let mut original = event(
            &format!("input-{index}"),
            "run-stream",
            index as u64 + 1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::TurnInput(TurnInput {
                thread_id: ThreadId::from("logical-thread"),
                run_id: Some(RunId::from("run-1")),
                content: content.clone(),
                provenance,
            }),
        );
        original.correlation.run_id = Some(RunId::from("run-1"));
        original.correlation.thread_id = Some(ThreadId::from("logical-thread"));

        let json = serde_json::to_value(&original).unwrap();
        assert_eq!(json["type"], "turn_input");
        assert_eq!(json["data"]["content"], content);
        assert_eq!(json["correlation"]["run_id"], "run-1");
        assert_eq!(json["correlation"]["thread_id"], "logical-thread");
        assert_eq!(
            serde_json::from_value::<HarnessEventV1>(json).unwrap(),
            original
        );
    }
}

#[test]
fn legacy_v1_unknown_round_trip_preserves_turn_input_canonical_identity_in_data() {
    let mut original = event(
        "legacy-input",
        "legacy-stream",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id: ThreadId::from("durable-thread"),
            run_id: Some(RunId::from("durable-run")),
            content: "preserve me exactly".into(),
            provenance: TurnInputProvenance::Agent,
        }),
    );
    original.correlation.session_id = Some(SessionId::from("legacy-session"));
    original.correlation.thread_id = Some(ThreadId::from("durable-thread"));
    original.correlation.run_id = Some(RunId::from("durable-run"));

    let legacy: LegacyWireEventV1 =
        serde_json::from_value(serde_json::to_value(original).unwrap()).unwrap();
    assert_eq!(
        legacy.payload(),
        LegacyPayloadV1::Unknown {
            event_type: "turn_input".into(),
            data: json!({
                "thread_id": "durable-thread",
                "run_id": "durable-run",
                "content": "preserve me exactly",
                "provenance": "agent",
            }),
        }
    );

    let round_tripped = serde_json::to_value(legacy).unwrap();
    assert_eq!(round_tripped["correlation"]["session_id"], "legacy-session");
    assert!(round_tripped["correlation"].get("thread_id").is_none());
    assert!(round_tripped["correlation"].get("run_id").is_none());

    let restored: HarnessEventV1 = serde_json::from_value(round_tripped).unwrap();
    let HarnessEventPayloadV1::TurnInput(input) = restored.payload else {
        panic!("legacy unknown event should decode after upgrading the reader");
    };
    assert_eq!(input.thread_id, ThreadId::from("durable-thread"));
    assert_eq!(input.run_id, Some(RunId::from("durable-run")));
    assert_eq!(input.content, "preserve me exactly");
}

#[test]
fn unknown_neutral_event_round_trip_is_lossless() {
    let raw = json!({
        "version": 1,
        "event_id": "future-1",
        "stream_id": "stream",
        "sequence": 1,
        "correlation": {"session_id": "session"},
        "timestamp": "2026-01-01T00:00:00Z",
        "semantics": "snapshot",
        "provider_sequence": 99,
        "type": "future_neutral_event",
        "data": {"nested": [1, true, "x"]}
    });
    let decoded: HarnessEventV1 = serde_json::from_value(raw.clone()).unwrap();
    assert!(matches!(
        decoded.payload,
        HarnessEventPayloadV1::Unknown { ref event_type, .. }
            if event_type == "future_neutral_event"
    ));
    assert_eq!(serde_json::to_value(decoded).unwrap(), raw);
}

#[test]
fn unsupported_version_and_invalid_known_payload_are_rejected() {
    let mut future = serde_json::to_value(event(
        "e",
        "s",
        1,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Text(TextEvent { text: "x".into() }),
    ))
    .unwrap();
    future["version"] = json!(2);
    assert!(serde_json::from_value::<HarnessEventV1>(future).is_err());

    let invalid = json!({
        "version": 1,
        "event_id": "e",
        "stream_id": "s",
        "sequence": 1,
        "timestamp": "2026-01-01T00:00:00Z",
        "semantics": "delta",
        "type": "text",
        "data": {"wrong": true}
    });
    assert!(serde_json::from_value::<HarnessEventV1>(invalid).is_err());
}

#[test]
fn capabilities_and_all_control_decisions_are_serializable() {
    let capabilities = HarnessCapabilities {
        provider: "test".into(),
        available: true,
        unavailable_reason: None,
        persistent_sessions: true,
        one_shot_runs: true,
        session_resumption: true,
        default_model: Some("m".into()),
        models: vec![ModelCapability {
            id: "m".into(),
            label: "Model".into(),
            reasoning_efforts: BTreeSet::from(["high".into()]),
        }],
        approval_categories: BTreeSet::from([
            ApprovalCategory::CommandExecution,
            ApprovalCategory::FileChange,
            ApprovalCategory::AdditionalPermission,
        ]),
        questions: QuestionCapabilities {
            multiple_selection: true,
            free_form_answers: true,
            automatic_resolution: true,
        },
    };
    assert_eq!(
        serde_json::from_value::<HarnessCapabilities>(serde_json::to_value(&capabilities).unwrap())
            .unwrap(),
        capabilities
    );

    let decisions = vec![
        ControlDecision::AllowOnce,
        ControlDecision::AllowForSession,
        ControlDecision::Deny,
        ControlDecision::Cancel,
        ControlDecision::Modified(json!({"cmd": "safe"})),
        ControlDecision::PermissionsGranted {
            permissions: vec!["network".into()],
            scope: GrantScope::Turn,
        },
        ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
            question_id: "q".into(),
            selected_option_ids: vec!["a".into(), "b".into()],
            free_form: Some("other".into()),
        }]),
    ];
    for decision in decisions {
        assert_eq!(
            serde_json::from_value::<ControlDecision>(serde_json::to_value(&decision).unwrap())
                .unwrap(),
            decision
        );
    }
}

#[test]
fn control_scenarios_round_trip_as_correlated_durable_pairs() {
    let scenarios = vec![
        (
            ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::CommandExecution,
                title: "Run?".into(),
                details: Some(json!({"cmd": "original"})),
                modification_supported: true,
            }),
            ControlDecision::AllowOnce,
            ResolutionSource::Consumer,
        ),
        (
            ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::FileChange,
                title: "Edit?".into(),
                details: None,
                modification_supported: true,
            }),
            ControlDecision::Modified(json!({"patch": "safe"})),
            ResolutionSource::Fallback,
        ),
        (
            ControlRequest::PermissionGrant(PermissionGrantRequest {
                permissions: vec!["filesystem".into(), "network".into()],
                scope_supported: vec![GrantScope::Turn, GrantScope::Session],
            }),
            ControlDecision::PermissionsGranted {
                permissions: vec!["filesystem".into()],
                scope: GrantScope::Session,
            },
            ResolutionSource::Timeout,
        ),
        (
            ControlRequest::UserQuestion {
                questions: vec![UserQuestion {
                    id: "q".into(),
                    prompt: "Choose".into(),
                    header: None,
                    options: vec![QuestionOption {
                        id: "a".into(),
                        label: "A".into(),
                        description: None,
                    }],
                    multiple: true,
                    free_form: true,
                }],
            },
            ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
                question_id: "q".into(),
                selected_option_ids: vec!["a".into()],
                free_form: Some("because".into()),
            }]),
            ResolutionSource::Interrupted,
        ),
        (
            ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::AdditionalPermission,
                title: "More?".into(),
                details: None,
                modification_supported: false,
            }),
            ControlDecision::Deny,
            ResolutionSource::Cancelled,
        ),
    ];

    for (index, (request, decision, source)) in scenarios.into_iter().enumerate() {
        let request_id = ControlRequestId::from(format!("request-{index}"));
        let requested = event(
            &format!("event-{index}-request"),
            "control",
            index as u64 * 2 + 1,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlRequested(ControlRequestEnvelope {
                request_id: request_id.clone(),
                session_id: Some(SessionId::from("session")),
                turn_id: Some(TurnId::from("turn")),
                thread_id: Some(ThreadId::from("thread")),
                is_root: Some(true),
                request,
                presentation: None,
                timeout_ms: Some(100),
                automatic_resolution: Some(ControlDecision::Deny),
            }),
        );
        let resolved = event(
            &format!("event-{index}-resolved"),
            "control",
            index as u64 * 2 + 2,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ControlResolved(ControlResolution {
                request_id: request_id.clone(),
                source,
                decision: Some(decision),
                message: None,
            }),
        );
        for original in [requested, resolved] {
            let decoded: HarnessEventV1 =
                serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
            assert_eq!(decoded, original);
            match decoded.payload {
                HarnessEventPayloadV1::ControlRequested(request) => {
                    assert_eq!(request.request_id, request_id)
                }
                HarnessEventPayloadV1::ControlResolved(resolution) => {
                    assert_eq!(resolution.request_id, request_id)
                }
                _ => unreachable!(),
            }
        }
    }
}
