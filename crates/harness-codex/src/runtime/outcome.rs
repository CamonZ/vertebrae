use serde_json::Value;
use vertebrae_harness_core::{
    CompletionStatus, HarnessError, OutcomeMetrics, SessionUsage, TokenUsage, TurnOutcome,
    TurnUsage,
};

use crate::{number, optional_string};

#[derive(Default)]
pub(crate) struct TurnAccumulator {
    pub(super) text: String,
    pub(super) usage: Option<TurnUsage>,
    pub(super) last_usage: Option<TurnUsage>,
    pub(super) context_tokens: Option<u64>,
    pub(super) context_window: Option<u64>,
}

pub(crate) fn failed_outcome(error: HarnessError) -> TurnOutcome {
    TurnOutcome {
        status: CompletionStatus::Failed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: Some(error.to_string()),
    }
}

pub(crate) fn validate_structured_output(
    mut outcome: TurnOutcome,
    schema: Option<&Value>,
) -> TurnOutcome {
    let Some(schema) = schema else {
        return outcome;
    };
    if outcome.status != CompletionStatus::Completed {
        return outcome;
    }

    if outcome.structured_output.is_none() {
        let Some(text) = outcome.result_text.as_deref() else {
            outcome.status = CompletionStatus::Failed;
            outcome.error = Some("Codex structured output was empty".into());
            return outcome;
        };
        match serde_json::from_str(text) {
            Ok(value) => outcome.structured_output = Some(value),
            Err(error) => {
                outcome.status = CompletionStatus::Failed;
                outcome.error = Some(format!(
                    "Codex structured output was not valid JSON: {error}"
                ));
                return outcome;
            }
        }
    }

    let validator = match jsonschema::validator_for(schema) {
        Ok(validator) => validator,
        Err(error) => {
            outcome.status = CompletionStatus::Failed;
            outcome.error = Some(format!(
                "Codex output schema could not be compiled: {error}"
            ));
            return outcome;
        }
    };
    let output = outcome
        .structured_output
        .as_ref()
        .expect("structured output is populated above");
    if let Err(error) = validator.validate(output) {
        outcome.status = CompletionStatus::Failed;
        outcome.error = Some(format!(
            "Codex structured output did not match the requested schema: {error}"
        ));
    }
    outcome
}

pub(crate) fn cancelled_outcome(status: CompletionStatus, usage: Option<TurnUsage>) -> TurnOutcome {
    let message = if status == CompletionStatus::Interrupted {
        "Codex turn interrupted"
    } else {
        "Codex turn cancelled"
    };
    TurnOutcome {
        status,
        result_text: None,
        structured_output: None,
        usage,
        metrics: OutcomeMetrics::default(),
        error: Some(message.into()),
    }
}
pub(crate) fn parse_usage(params: &Value) -> (Option<TurnUsage>, Option<SessionUsage>) {
    let total = |field: &str| number(params, &[&format!("/tokenUsage/total/{field}")]);
    let last = |field: &str| number(params, &[&format!("/tokenUsage/last/{field}")]);
    let fallback =
        |field: &str| total(field).or_else(|| number(params, &[&format!("/tokenUsage/{field}")]));
    let turn_tokens = TokenUsage {
        input_tokens: last("inputTokens")
            .or_else(|| fallback("inputTokens"))
            .unwrap_or(0),
        cached_input_tokens: last("cachedInputTokens")
            .or_else(|| fallback("cachedInputTokens"))
            .unwrap_or(0),
        output_tokens: last("outputTokens")
            .or_else(|| fallback("outputTokens"))
            .unwrap_or(0),
        reasoning_tokens: last("reasoningOutputTokens")
            .or_else(|| last("reasoningTokens"))
            .or_else(|| fallback("reasoningOutputTokens"))
            .or_else(|| fallback("reasoningTokens"))
            .unwrap_or(0),
    };
    let thread_tokens = TokenUsage {
        input_tokens: fallback("inputTokens").unwrap_or(0),
        cached_input_tokens: fallback("cachedInputTokens").unwrap_or(0),
        output_tokens: fallback("outputTokens").unwrap_or(0),
        reasoning_tokens: fallback("reasoningOutputTokens")
            .or_else(|| fallback("reasoningTokens"))
            .unwrap_or(0),
    };
    let turn =
        (turn_tokens.input_tokens > 0 || turn_tokens.output_tokens > 0).then_some(TurnUsage {
            tokens: turn_tokens,
            cost_microusd: 0,
        });
    let snapshot =
        (thread_tokens.input_tokens > 0 || thread_tokens.output_tokens > 0).then(|| SessionUsage {
            tokens: thread_tokens,
            cost_microusd: 0,
            context_tokens: last("totalTokens").or_else(|| fallback("totalTokens")),
            context_window: number(params, &["/tokenUsage/modelContextWindow"]),
        });
    (turn, snapshot)
}

pub(crate) fn usage_delta(previous: Option<&TurnUsage>, current: &TurnUsage) -> TurnUsage {
    let previous = previous.cloned().unwrap_or_default();
    TurnUsage {
        tokens: TokenUsage {
            input_tokens: current
                .tokens
                .input_tokens
                .saturating_sub(previous.tokens.input_tokens),
            cached_input_tokens: current
                .tokens
                .cached_input_tokens
                .saturating_sub(previous.tokens.cached_input_tokens),
            output_tokens: current
                .tokens
                .output_tokens
                .saturating_sub(previous.tokens.output_tokens),
            reasoning_tokens: current
                .tokens
                .reasoning_tokens
                .saturating_sub(previous.tokens.reasoning_tokens),
        },
        cost_microusd: current.cost_microusd.saturating_sub(previous.cost_microusd),
    }
}

pub(crate) fn completion_status(status: &str) -> CompletionStatus {
    match status {
        "completed" => CompletionStatus::Completed,
        "cancelled" | "canceled" => CompletionStatus::Cancelled,
        "interrupted" => CompletionStatus::Interrupted,
        _ => CompletionStatus::Failed,
    }
}

pub(crate) fn outcome_from_completion(
    params: &Value,
    status: String,
    accumulator: &TurnAccumulator,
) -> TurnOutcome {
    let status = completion_status(&status);
    let error = (status != CompletionStatus::Completed).then(|| {
        optional_string(
            params,
            &["/error/message", "/turn/error/message", "/message"],
        )
        .unwrap_or_else(|| "Codex turn failed".into())
    });
    let structured_output = ["/turn/structuredOutput", "/structuredOutput"]
        .iter()
        .find_map(|pointer| params.pointer(pointer))
        .cloned()
        .or_else(|| {
            ["/turn/result", "/result"]
                .iter()
                .find_map(|pointer| params.pointer(pointer))
                .and_then(|value| match value {
                    Value::String(value) => serde_json::from_str(value).ok(),
                    value => Some(value.clone()),
                })
        });
    TurnOutcome {
        status,
        result_text: (!accumulator.text.is_empty())
            .then(|| accumulator.text.clone())
            .or_else(|| optional_string(params, &["/turn/result", "/result"])),
        structured_output,
        usage: accumulator.usage.clone(),
        metrics: OutcomeMetrics {
            duration_ms: number(params, &["/turn/durationMs"]),
            turn_count: None,
            context_tokens: accumulator.context_tokens,
            context_window: accumulator.context_window,
            total_cost_usd: None,
        },
        error,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn keeps_thread_totals_separate_from_last_turn_context_usage() {
        let params = json!({
            "tokenUsage": {
                "total": {
                    "totalTokens": 979558,
                    "inputTokens": 969766,
                    "cachedInputTokens": 841984,
                    "outputTokens": 9792,
                    "reasoningOutputTokens": 3276,
                },
                "last": {
                    "totalTokens": 98480,
                    "inputTokens": 96621,
                    "cachedInputTokens": 94976,
                    "outputTokens": 1859,
                    "reasoningOutputTokens": 516,
                },
                "modelContextWindow": 258400,
            }
        });

        let (turn, snapshot) = parse_usage(&params);
        let turn = turn.expect("last usage should populate the turn delta");
        let snapshot = snapshot.expect("total usage should populate the thread snapshot");
        assert_eq!(turn.tokens.input_tokens, 96621);
        assert_eq!(turn.tokens.output_tokens, 1859);
        assert_eq!(snapshot.tokens.input_tokens, 969766);
        assert_eq!(snapshot.tokens.output_tokens, 9792);
        assert_eq!(snapshot.context_tokens, Some(98480));
        assert_eq!(snapshot.context_window, Some(258400));
    }
}
