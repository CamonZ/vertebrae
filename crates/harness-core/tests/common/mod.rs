#![allow(dead_code)]

use chrono::{TimeZone, Utc};
use vertebrae_harness_core::*;

pub fn outcome(status: CompletionStatus) -> TurnOutcome {
    TurnOutcome {
        status,
        result_text: Some("done".into()),
        structured_output: None,
        usage: Some(TurnUsage {
            tokens: TokenUsage {
                input_tokens: 3,
                cached_input_tokens: 1,
                output_tokens: 2,
                reasoning_tokens: 1,
            },
            cost_microusd: 7,
        }),
        metrics: OutcomeMetrics::default(),
        error: None,
    }
}

pub fn event(
    id: &str,
    stream: &str,
    sequence: u64,
    semantics: UpdateSemantics,
    payload: HarnessEventPayloadV1,
) -> HarnessEventV1 {
    HarnessEventV1 {
        event_id: EventId::from(id),
        stream_id: StreamId::from(stream),
        sequence,
        correlation: EventCorrelation {
            session_id: Some(SessionId::from(format!("session-{stream}"))),
            thread_id: Some(ThreadId::from(format!("thread-{stream}"))),
            turn_id: Some(TurnId::from(format!("turn-{stream}"))),
            run_id: None,
            item_id: Some(ItemId::from(format!("item-{sequence}"))),
            tool_call_id: None,
            parent_tool_call_id: Some(ToolCallId::from("parent")),
            provider_resume_id: Some(ProviderResumeId::from("resume-1")),
        },
        timestamp: Utc.timestamp_opt(sequence as i64, 0).unwrap(),
        semantics,
        provider_sequence: Some(sequence + 10),
        payload,
    }
}

pub fn text_event(id: &str, stream: &str, sequence: u64, text: &str) -> HarnessEventV1 {
    event(
        id,
        stream,
        sequence,
        UpdateSemantics::Delta,
        HarnessEventPayloadV1::Text(TextEvent {
            text: text.into(),
            ..Default::default()
        }),
    )
}
