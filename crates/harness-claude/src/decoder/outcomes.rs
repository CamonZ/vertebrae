use serde_json::{Map, Value};
use vertebrae_harness_core::{
    CompletionStatus, HarnessEventDraftV1, HarnessEventPayloadV1, RunOutcome, SessionUsage,
    ThreadId, ToolCallId, TurnOutcome, TurnUsage, UpdateSemantics, UsageEvent,
};

use super::ClaudeStreamDecoder;
use super::drafts::string;

impl ClaudeStreamDecoder {
    pub(super) fn decode_result(
        &self,
        object: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &super::StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) {
        let total_cost_usd = object
            .get("total_cost_usd")
            .or_else(|| object.get("cost_usd"))
            .and_then(Value::as_f64);
        let mut usage = object
            .get("usage")
            .and_then(Value::as_object)
            .map(turn_usage);
        if let Some(usage) = &mut usage {
            usage.cost_microusd = total_cost_usd
                .map(|cost| (cost * 1_000_000.0).round() as u64)
                .unwrap_or(usage.cost_microusd);
        }
        if let Some(usage) = &usage {
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent.clone(),
                UpdateSemantics::Delta,
                HarnessEventPayloadV1::Usage(UsageEvent {
                    turn_delta: Some(usage.clone()),
                    session_snapshot: None,
                }),
            ));
        }
        let failed = object
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || matches!(string(object, "subtype"), Some("error"));
        let status = if failed {
            CompletionStatus::Failed
        } else {
            CompletionStatus::Completed
        };
        let result_text = string(object, "result").map(str::to_owned);
        let structured_output = object.get("structured_output").cloned();
        let metrics = vertebrae_harness_core::OutcomeMetrics {
            duration_ms: object.get("duration_ms").and_then(Value::as_u64),
            turn_count: object.get("num_turns").and_then(Value::as_u64),
            // Claude's result record carries cumulative model usage. As in the
            // legacy GUI parser, only its maximum context window is meaningful;
            // terminal context tokens are explicitly zero.
            context_tokens: Some(0),
            context_window: Some(result_context_window(object)),
            total_cost_usd,
        };
        let error = failed.then(|| {
            result_text
                .clone()
                .unwrap_or_else(|| "Claude run failed".into())
        });
        let payload = if self.context.run_id.is_some() {
            HarnessEventPayloadV1::RunFinished(RunOutcome {
                status,
                result_text,
                structured_output,
                usage,
                metrics,
                error,
            })
        } else {
            HarnessEventPayloadV1::TurnFinished(TurnOutcome {
                status,
                result_text,
                structured_output,
                usage,
                metrics,
                error,
            })
        };
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent,
            UpdateSemantics::Snapshot,
            payload,
        ));
    }

    pub(super) fn usage_draft(
        &self,
        stream_id: super::StreamId,
        thread_id: &ThreadId,
        parent: Option<ToolCallId>,
        usage: &Map<String, Value>,
    ) -> HarnessEventDraftV1 {
        let turn = turn_usage(usage);
        let context_tokens = turn
            .tokens
            .input_tokens
            .saturating_add(turn.tokens.cached_input_tokens);
        self.draft(
            stream_id,
            thread_id,
            parent,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Usage(UsageEvent {
                turn_delta: None,
                session_snapshot: Some(SessionUsage {
                    tokens: turn.tokens,
                    cost_microusd: turn.cost_microusd,
                    context_tokens: Some(context_tokens),
                    context_window: Some(super::DEFAULT_CONTEXT_WINDOW),
                }),
            }),
        )
    }
}

pub(super) fn result_context_window(object: &Map<String, Value>) -> u64 {
    object
        .get("modelUsage")
        .or_else(|| object.get("model_usage"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|usage| usage.values())
        .filter_map(|usage| {
            usage
                .get("contextWindow")
                .or_else(|| usage.get("context_window"))
                .and_then(Value::as_u64)
        })
        .max()
        .unwrap_or(super::DEFAULT_CONTEXT_WINDOW)
}

fn u64_field(object: &Map<String, Value>, key: &str) -> u64 {
    object.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub(super) fn turn_usage(object: &Map<String, Value>) -> TurnUsage {
    let input = u64_field(object, "input_tokens");
    let cache_read = u64_field(object, "cache_read_input_tokens");
    let cache_create = u64_field(object, "cache_creation_input_tokens");
    TurnUsage {
        tokens: vertebrae_harness_core::TokenUsage {
            input_tokens: input,
            cached_input_tokens: cache_read.saturating_add(cache_create),
            output_tokens: u64_field(object, "output_tokens"),
            reasoning_tokens: u64_field(object, "thinking_tokens"),
        },
        cost_microusd: object
            .get("cost_usd")
            .and_then(Value::as_f64)
            .map(|cost| (cost * 1_000_000.0).round() as u64)
            .unwrap_or(0),
    }
}
