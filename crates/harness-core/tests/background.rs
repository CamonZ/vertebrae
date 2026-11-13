use chrono::{TimeZone, Utc};
use serde_json::json;
use vertebrae_harness_core::*;

fn event(sequence: u64, payload: HarnessEventPayloadV1) -> HarnessEventV1 {
    HarnessEventV1 {
        event_id: EventId::new(format!("event-{sequence}")),
        stream_id: StreamId::new("stream"),
        sequence,
        correlation: EventCorrelation {
            session_id: Some(SessionId::from("session")),
            thread_id: Some(ThreadId::new("thread")),
            turn_id: Some(TurnId::from("turn-1")),
            ..EventCorrelation::default()
        },
        timestamp: Utc.timestamp_opt(1_800_000_000, 0).unwrap(),
        semantics: UpdateSemantics::Snapshot,
        provider_sequence: None,
        payload,
    }
}

fn round_trips(event: &HarnessEventV1, wire_type: &str) {
    let wire = serde_json::to_value(event).unwrap();

    assert_eq!(wire["type"], wire_type);
    assert_eq!(
        &serde_json::from_value::<HarnessEventV1>(wire).unwrap(),
        event
    );
}

#[test]
fn background_payloads_round_trip() {
    let mut work = BackgroundWorkEvent::new(
        "task-1",
        BackgroundWorkKind::Command,
        BackgroundWorkStatus::Running,
    );
    work.description = Some("npm run dev".into());
    work.launch_tool_call_id = Some(ToolCallId::from("toolu_1"));

    let roster = BackgroundRosterEvent {
        work: vec![BackgroundRosterEntry {
            work_id: BackgroundWorkId::from("task-1"),
            kind: BackgroundWorkKind::Command,
            provider_kind: Some("local_bash".into()),
            description: None,
        }],
    };

    round_trips(
        &event(1, HarnessEventPayloadV1::BackgroundWork(work)),
        "background_work",
    );
    round_trips(
        &event(2, HarnessEventPayloadV1::BackgroundRoster(roster)),
        "background_roster",
    );
}

#[test]
fn unknown_provider_values_degrade_instead_of_failing() {
    let minimal: BackgroundWorkEvent = serde_json::from_value(json!({
        "work_id": "w", "kind": "remote_shell", "status": "suspended"
    }))
    .unwrap();

    assert_eq!(minimal.generation, 0);
    assert_eq!(minimal.kind, BackgroundWorkKind::Other);
    assert_eq!(minimal.status, BackgroundWorkStatus::Unknown);
}
