//! Parser for Codex `exec --json` output.
//!
//! Codex emits newline-delimited JSON when invoked with `exec --json`. Each
//! line is a JSON object with a `type` field. This module folds the events
//! into a single `CodexAggregate` carrying the fields the daemon cares about:
//! the final assistant reply, the cumulative token usage, and any failure
//! message. Raw lines are still stored verbatim as `SessionLog`s by the step
//! executor, so this parser only surfaces the structured-result projection.
//!
//! Recognized event types (per `codex-rs/exec/src/exec_events.rs`):
//! `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
//! `item.started`, `item.updated`, `item.completed`, `error`.
//! There is no `thread.completed` or `thread.failed` event in the upstream
//! schema -- streams just terminate, and fatal errors arrive as a top-level
//! `error` event with shape `{"type":"error","message":"..."}`.
//! Anything else is ignored.

use serde::Deserialize;

/// Token usage extracted from a Codex `turn.completed` event.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CodexUsage {
    /// Input tokens consumed by the turn (defaults to 0 if missing).
    pub input_tokens: i64,
    /// Cached input tokens (Codex reports these separately; rolled up into
    /// the daemon's `input_tokens` metric on conversion).
    pub cached_input_tokens: i64,
    /// Output tokens produced by the turn (defaults to 0 if missing).
    pub output_tokens: i64,
    /// Reasoning output tokens produced by the turn (defaults to 0 if missing).
    pub reasoning_output_tokens: i64,
}

/// Aggregate state built up by streaming Codex events.
///
/// Mirrors `crate::stream_json::ParsedStreamResult` so the step executor can
/// surface the same `(metrics, output)` pair it does for Claude.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexAggregate {
    /// The most recent `turn.completed` usage, if any.
    pub usage: Option<CodexUsage>,
    /// The text of the *last* completed `agent_message` item -- this is what
    /// Codex treats as the user-facing final reply.
    pub final_output: Option<String>,
    /// `Some(message)` if any `turn.failed` or top-level `error` was observed.
    pub error: Option<String>,
}

/// Fold a single Codex JSONL line into the aggregate. Returns `true` when
/// the line was a parseable JSON object (whether or not it contributed any
/// fields), `false` for empty lines, malformed JSON, or non-object roots.
pub fn apply_codex_line(line: &str, aggregate: &mut CodexAggregate) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return false;
    };
    if !value.is_object() {
        return false;
    }

    let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match event_type {
        "item.completed" => {
            if let Some(text) = extract_agent_message_text(&value) {
                aggregate.final_output = Some(text);
            }
        }
        "turn.completed" => {
            if let Some(usage) = extract_usage(&value) {
                aggregate.usage = Some(usage);
            }
        }
        "turn.failed" => {
            if let Some(msg) = extract_turn_failed_message(&value)
                && aggregate.error.is_none()
            {
                aggregate.error = Some(msg);
            }
        }
        "error" => {
            if let Some(msg) = extract_top_level_error_message(&value)
                && aggregate.error.is_none()
            {
                aggregate.error = Some(msg);
            }
        }
        // `item.started` carries an in-progress snapshot whose final state
        // arrives on `item.completed`. `item.updated` is emitted only for
        // TodoList plan refinements (per upstream `TurnPlanUpdated`); the
        // daemon doesn't surface TodoList state to the aggregate -- the
        // GUI re-parses the raw session log lines if it wants to render it.
        _ => {}
    }
    true
}

/// Pull the agent-message text out of an `item.completed` event. Returns
/// `None` for items whose `type` is not `agent_message` or whose `text`
/// field is missing/empty.
///
/// Per the upstream schema, `ThreadItemDetails` is `#[serde(tag = "type",
/// rename_all = "snake_case")]` flattened into `ThreadItem`, so the
/// discriminator is `item.type` (not `item.item_type`).
fn extract_agent_message_text(value: &serde_json::Value) -> Option<String> {
    let item = value.get("item")?;
    let item_type = item.get("type").and_then(|t| t.as_str())?;
    if item_type != "agent_message" {
        return None;
    }
    let text = item.get("text").and_then(|t| t.as_str())?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// Decode the `usage` object on a `turn.completed` event.
fn extract_usage(value: &serde_json::Value) -> Option<CodexUsage> {
    #[derive(Deserialize)]
    struct UsageWire {
        #[serde(default)]
        input_tokens: Option<i64>,
        #[serde(default)]
        cached_input_tokens: Option<i64>,
        #[serde(default)]
        output_tokens: Option<i64>,
        #[serde(default)]
        reasoning_output_tokens: Option<i64>,
    }

    let wire: UsageWire = serde_json::from_value(value.get("usage")?.clone()).ok()?;
    Some(CodexUsage {
        input_tokens: wire.input_tokens.unwrap_or(0),
        cached_input_tokens: wire.cached_input_tokens.unwrap_or(0),
        output_tokens: wire.output_tokens.unwrap_or(0),
        reasoning_output_tokens: wire.reasoning_output_tokens.unwrap_or(0),
    })
}

/// Pull the human-readable error message out of a `turn.failed` event. The
/// upstream `TurnFailedEvent` always carries `error.message`.
fn extract_turn_failed_message(value: &serde_json::Value) -> Option<String> {
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// Pull the message off a top-level `error` event. The upstream
/// `ThreadErrorEvent` puts `message` directly on the event object.
fn extract_top_level_error_message(value: &serde_json::Value) -> Option<String> {
    value
        .get("message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_completed_with_agent_message_sets_final_output() {
        let line = r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Hello, world."}}"#;
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(line, &mut agg));
        assert_eq!(agg.final_output.as_deref(), Some("Hello, world."));
        assert!(agg.usage.is_none());
        assert!(agg.error.is_none());
    }

    #[test]
    fn agent_message_with_empty_text_is_ignored() {
        let line =
            r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":""}}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        assert!(agg.final_output.is_none());
    }

    #[test]
    fn non_agent_message_item_does_not_set_final_output() {
        let line = r#"{"type":"item.completed","item":{"id":"i3","type":"command_execution","command":"ls","exit_code":0,"status":"completed","aggregated_output":""}}"#;
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(line, &mut agg));
        assert!(agg.final_output.is_none());
    }

    #[test]
    fn last_agent_message_wins_when_multiple_are_emitted() {
        let lines = [
            r#"{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"first"}}"#,
            r#"{"type":"item.completed","item":{"id":"b","type":"agent_message","text":"final answer"}}"#,
        ];
        let mut agg = CodexAggregate::default();
        for line in lines {
            apply_codex_line(line, &mut agg);
        }
        assert_eq!(agg.final_output.as_deref(), Some("final answer"));
    }

    #[test]
    fn turn_completed_extracts_usage_metrics() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":1500,"cached_input_tokens":200,"output_tokens":800,"reasoning_output_tokens":120}}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        let usage = agg.usage.expect("usage must be set");
        assert_eq!(usage.input_tokens, 1500);
        assert_eq!(usage.cached_input_tokens, 200);
        assert_eq!(usage.output_tokens, 800);
        assert_eq!(usage.reasoning_output_tokens, 120);
    }

    #[test]
    fn turn_completed_with_partial_usage_defaults_missing_to_zero() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":42}}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        let usage = agg.usage.expect("usage must be set");
        assert_eq!(usage.input_tokens, 42);
        assert_eq!(usage.cached_input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.reasoning_output_tokens, 0);
    }

    #[test]
    fn turn_completed_without_usage_field_yields_no_usage() {
        let line = r#"{"type":"turn.completed"}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        assert!(agg.usage.is_none());
    }

    #[test]
    fn later_turn_completed_overwrites_earlier_usage() {
        let lines = [
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":300,"output_tokens":150}}"#,
        ];
        let mut agg = CodexAggregate::default();
        for line in lines {
            apply_codex_line(line, &mut agg);
        }
        let usage = agg.usage.expect("usage must be set");
        assert_eq!(usage.input_tokens, 300);
        assert_eq!(usage.output_tokens, 150);
    }

    #[test]
    fn turn_failed_records_error_message() {
        let line = r#"{"type":"turn.failed","error":{"message":"rate limit exceeded"}}"#;
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(line, &mut agg));
        assert_eq!(agg.error.as_deref(), Some("rate limit exceeded"));
    }

    #[test]
    fn top_level_error_event_records_error_message() {
        // ThreadErrorEvent shape: `{"type":"error","message":"..."}`.
        // This is the upstream replacement for the (non-existent)
        // `thread.failed` event.
        let line = r#"{"type":"error","message":"sandbox denied"}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        assert_eq!(agg.error.as_deref(), Some("sandbox denied"));
    }

    #[test]
    fn first_failure_message_wins_when_multiple_failures_arrive() {
        let lines = [
            r#"{"type":"turn.failed","error":{"message":"first failure"}}"#,
            r#"{"type":"error","message":"second failure"}"#,
        ];
        let mut agg = CodexAggregate::default();
        for line in lines {
            apply_codex_line(line, &mut agg);
        }
        assert_eq!(agg.error.as_deref(), Some("first failure"));
    }

    #[test]
    fn unknown_event_type_parses_but_does_not_touch_aggregate() {
        let line = r#"{"type":"item.delta","delta":"streaming chunk"}"#;
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(line, &mut agg));
        assert!(agg.final_output.is_none());
        assert!(agg.usage.is_none());
        assert!(agg.error.is_none());
    }

    #[test]
    fn item_updated_is_recognized_but_does_not_touch_aggregate() {
        // Per upstream, `item.updated` is emitted only for TodoList plan
        // refinements -- not as a streaming marker for agent_message text.
        // The daemon doesn't surface TodoList state to the aggregate.
        let line = r#"{"type":"item.updated","item":{"id":"plan1","type":"todo_list","items":[{"text":"step a","completed":true},{"text":"step b","completed":false}]}}"#;
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(line, &mut agg));
        assert!(agg.final_output.is_none());
        assert!(agg.usage.is_none());
        assert!(agg.error.is_none());
    }

    #[test]
    fn malformed_or_empty_input_is_rejected() {
        let mut agg = CodexAggregate::default();
        assert!(!apply_codex_line("not json", &mut agg));
        assert!(!apply_codex_line("{broken", &mut agg));
        assert!(!apply_codex_line("", &mut agg));
        assert!(!apply_codex_line("   ", &mut agg));
        // A top-level array isn't a Codex event; we require an object.
        assert!(!apply_codex_line(r#"["thread.started"]"#, &mut agg));
    }

    #[test]
    fn event_without_type_field_is_a_no_op_but_parses() {
        let mut agg = CodexAggregate::default();
        assert!(apply_codex_line(r#"{"foo":"bar"}"#, &mut agg));
        assert!(agg.final_output.is_none());
    }

    #[test]
    fn full_session_aggregates_final_output_and_usage_and_no_error() {
        // Note: there is no `thread.completed` event in the upstream schema
        // -- successful streams just terminate after `turn.completed`.
        let session = [
            r#"{"type":"thread.started","thread_id":"thr-abc"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"r1","type":"reasoning","text":"thinking..."}}"#,
            r#"{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"thought"}}"#,
            r#"{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls","status":"in_progress","aggregated_output":""}}"#,
            r#"{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","exit_code":0,"status":"completed","aggregated_output":"foo\nbar"}}"#,
            r#"{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"All done."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":2000,"cached_input_tokens":100,"output_tokens":900,"reasoning_output_tokens":40}}"#,
        ];

        let mut agg = CodexAggregate::default();
        for line in session {
            apply_codex_line(line, &mut agg);
        }

        assert_eq!(agg.final_output.as_deref(), Some("All done."));
        let usage = agg.usage.expect("usage");
        assert_eq!(usage.input_tokens, 2000);
        assert_eq!(usage.cached_input_tokens, 100);
        assert_eq!(usage.output_tokens, 900);
        assert_eq!(usage.reasoning_output_tokens, 40);
        assert!(agg.error.is_none());
    }

    #[test]
    fn extra_unknown_fields_on_known_event_do_not_break_parsing() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"future_field":"x"},"new_top_field":42}"#;
        let mut agg = CodexAggregate::default();
        apply_codex_line(line, &mut agg);
        let usage = agg.usage.expect("usage");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);
    }
}
