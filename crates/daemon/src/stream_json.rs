//! Parser for Claude Code `--output-format stream-json` output.
//!
//! Claude Code emits newline-delimited JSON when invoked with `--output-format stream-json`.
//! Each line is a JSON object with a `type` field indicating the message kind.
//! The final line with `type: "result"` contains usage metrics that we extract.

use serde::Deserialize;

/// Metrics extracted from a Claude Code stream-json result message.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamMetrics {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub duration_ms: i64,
}

/// Minimal deserializable shape of a stream-json line.
/// We only care about the `type` field to identify result messages.
#[derive(Deserialize)]
struct StreamLine {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    cost_usd: Option<f64>,
    #[serde(default)]
    duration_ms: Option<f64>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: Option<i64>,
    #[serde(default)]
    output_tokens: Option<i64>,
}

/// Parsed result from a stream-json result line, containing both metrics and result text.
#[derive(Debug)]
pub struct ParsedStreamResult {
    pub metrics: Option<StreamMetrics>,
    pub result_text: Option<String>,
    pub structured_output: Option<serde_json::Value>,
}

/// Minimal deserializable shape of a stream-json `system`/`init` line.
///
/// Claude Code emits one of these at session start. Its `tools` array lists
/// the tools advertised to the model; the `StructuredOutput` entry is the
/// source of truth for whether `--json-schema` was honored. Used for verbose
/// daemon logging only.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamInitLine {
    pub session_id: Option<String>,
    /// Raw `tools` JSON value as emitted by claude. Sometimes a list of strings,
    /// sometimes a list of `{name, ...}` objects depending on CLI version, so we
    /// keep the raw shape and let consumers (and `structured_output_advertised`)
    /// inspect it. Logged verbatim by the daemon for diagnostic clarity.
    pub tools: serde_json::Value,
}

impl StreamInitLine {
    /// True if `StructuredOutput` appears anywhere in the advertised tool list,
    /// whether the entries are strings (`"StructuredOutput"`) or objects
    /// (`{"name":"StructuredOutput", ...}`).
    pub fn structured_output_advertised(&self) -> bool {
        let Some(arr) = self.tools.as_array() else {
            return false;
        };
        arr.iter().any(|t| match t {
            serde_json::Value::String(s) => s == "StructuredOutput",
            serde_json::Value::Object(map) => {
                map.get("name").and_then(|n| n.as_str()) == Some("StructuredOutput")
            }
            _ => false,
        })
    }
}

#[derive(Deserialize)]
struct InitLine {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    tools: serde_json::Value,
}

/// Parsed stream-json fields needed to decide whether a raw log line is
/// durable history or an ephemeral status snapshot.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StreamLogLine {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// How a stream-json line should be persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamLogPersistence {
    Durable,
    Ephemeral { logical_key: String },
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

/// Attempt to parse a single stream-json line as a `system`/`init` message.
///
/// Returns `Some(StreamInitLine)` only for `{"type":"system","subtype":"init",...}`.
/// Returns `None` for any other line (including non-init system messages,
/// result/assistant lines, and unparseable input).
pub fn parse_stream_json_init_line(line: &str) -> Option<StreamInitLine> {
    // Fast-path: avoid full JSON deserialization for non-system lines.
    if !line.contains("\"type\":\"system\"") {
        return None;
    }

    let parsed: InitLine = serde_json::from_str(line).ok()?;
    if parsed.msg_type != "system" || parsed.subtype.as_deref() != Some("init") {
        return None;
    }

    Some(StreamInitLine {
        session_id: parsed.session_id,
        tools: parsed.tools,
    })
}

/// Parse the subset of a stream-json line needed for session log persistence.
///
/// Returns `None` for malformed JSON. Callers should treat that as durable
/// append so unexpected provider output is retained.
pub fn parse_stream_log_line(line: &str) -> Option<StreamLogLine> {
    serde_json::from_str(line).ok()
}

/// Classify a parsed Claude stream-json line for session log persistence.
///
/// Unknown current or future types deliberately remain durable append-only.
pub fn classify_stream_log_line(line: &StreamLogLine) -> StreamLogPersistence {
    match (line.msg_type.as_str(), line.subtype.as_deref()) {
        ("system", Some("thinking_tokens")) => {
            if let Some(session_id) = non_empty(&line.session_id) {
                StreamLogPersistence::Ephemeral {
                    logical_key: format!("thinking:{session_id}"),
                }
            } else {
                StreamLogPersistence::Durable
            }
        }
        ("system", Some("task_progress")) => {
            if let Some(tool_use_id) = non_empty(&line.tool_use_id) {
                StreamLogPersistence::Ephemeral {
                    logical_key: format!("task_progress:{tool_use_id}"),
                }
            } else {
                StreamLogPersistence::Durable
            }
        }
        ("rate_limit_event", _) => {
            if let Some(session_id) = non_empty(&line.session_id) {
                StreamLogPersistence::Ephemeral {
                    logical_key: format!("rate_limit:{session_id}"),
                }
            } else {
                StreamLogPersistence::Durable
            }
        }
        _ => StreamLogPersistence::Durable,
    }
}

/// Attempt to parse a single stream-json line as a result message.
///
/// Returns `Some(ParsedStreamResult)` if the line is a valid result message,
/// or `None` if it is a non-result message or unparseable.
/// Extracts both metrics and result text in a single deserialization pass.
pub fn parse_stream_json_line(line: &str) -> Option<ParsedStreamResult> {
    // Fast-path: skip full JSON deserialization for non-result lines.
    if !line.contains("\"type\":\"result\"") {
        return None;
    }

    let parsed: StreamLine = serde_json::from_str(line).ok()?;

    if parsed.msg_type != "result" {
        return None;
    }

    let metrics = parsed.usage.map(|usage| {
        let input_tokens = usage.input_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.unwrap_or(0);
        let cost_usd = parsed.cost_usd.unwrap_or(0.0);
        let duration_ms = parsed.duration_ms.unwrap_or(0.0) as i64;

        StreamMetrics {
            input_tokens,
            output_tokens,
            cost_usd,
            duration_ms,
        }
    });

    Some(ParsedStreamResult {
        metrics,
        result_text: parsed.result,
        structured_output: parsed.structured_output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_result_line_extracts_all_metrics() {
        let line = r#"{"type":"result","subtype":"success","cost_usd":0.003,"duration_ms":5432.1,"duration_api_ms":4500.0,"is_error":false,"num_turns":3,"result":"Done","session_id":"abc123","total_cost_usd":0.003,"usage":{"input_tokens":1500,"output_tokens":800}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 1500);
        assert_eq!(metrics.output_tokens, 800);
        assert!((metrics.cost_usd - 0.003).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 5432);
        assert_eq!(parsed.result_text.as_deref(), Some("Done"));
    }

    #[test]
    fn parse_non_result_line_returns_none() {
        let line = r#"{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#;

        assert!(parse_stream_json_line(line).is_none());
    }

    #[test]
    fn parse_system_init_line_returns_none() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc","tools":[]}"#;

        assert!(parse_stream_json_line(line).is_none());
    }

    #[test]
    fn parse_content_block_delta_returns_none() {
        let line = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;

        assert!(parse_stream_json_line(line).is_none());
    }

    #[test]
    fn parse_malformed_json_returns_none() {
        assert!(parse_stream_json_line("not json at all").is_none());
        assert!(parse_stream_json_line("{broken").is_none());
        assert!(parse_stream_json_line("").is_none());
    }

    #[test]
    fn parse_result_without_usage_has_no_metrics() {
        let line = r#"{"type":"result","cost_usd":0.001,"duration_ms":100.0}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        assert!(parsed.metrics.is_none());
    }

    #[test]
    fn parse_result_with_partial_usage_defaults_missing_to_zero() {
        let line = r#"{"type":"result","cost_usd":0.002,"duration_ms":200.0,"usage":{"input_tokens":500}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse with partial usage");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 500);
        assert_eq!(metrics.output_tokens, 0);
        assert!((metrics.cost_usd - 0.002).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 200);
    }

    #[test]
    fn parse_result_with_empty_usage_defaults_all_to_zero() {
        let line = r#"{"type":"result","usage":{}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse with empty usage");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 0);
        assert_eq!(metrics.output_tokens, 0);
        assert!((metrics.cost_usd - 0.0).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 0);
    }

    #[test]
    fn parse_result_with_zero_values() {
        let line = r#"{"type":"result","cost_usd":0.0,"duration_ms":0.0,"usage":{"input_tokens":0,"output_tokens":0}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse zero-valued result");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 0);
        assert_eq!(metrics.output_tokens, 0);
        assert!((metrics.cost_usd - 0.0).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 0);
    }

    #[test]
    fn parse_result_with_large_token_counts() {
        let line = r#"{"type":"result","cost_usd":1.5,"duration_ms":120000.0,"usage":{"input_tokens":200000,"output_tokens":100000}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse large values");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 200_000);
        assert_eq!(metrics.output_tokens, 100_000);
        assert!((metrics.cost_usd - 1.5).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 120_000);
    }

    #[test]
    fn parse_result_text_extracts_result_field() {
        let line = r#"{"type":"result","result":"Task completed successfully","cost_usd":0.01,"duration_ms":1000.0,"usage":{"input_tokens":100,"output_tokens":50}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        assert_eq!(
            parsed.result_text.as_deref(),
            Some("Task completed successfully")
        );
    }

    #[test]
    fn parse_result_text_returns_none_for_non_result() {
        let line = r#"{"type":"assistant","message":{}}"#;

        assert!(parse_stream_json_line(line).is_none());
    }

    #[test]
    fn parse_result_text_returns_none_when_result_field_absent() {
        let line =
            r#"{"type":"result","cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":50}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        assert!(parsed.result_text.is_none());
    }

    #[test]
    fn stream_metrics_clone_and_debug() {
        let metrics = StreamMetrics {
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.01,
            duration_ms: 500,
        };
        let cloned = metrics.clone();
        assert_eq!(cloned, metrics);

        let debug = format!("{:?}", metrics);
        assert!(debug.contains("100"));
        assert!(debug.contains("50"));
        assert!(debug.contains("0.01"));
        assert!(debug.contains("500"));
    }

    #[test]
    fn parse_result_with_structured_output_populates_field() {
        let line = r#"{"type":"result","result":"","structured_output":{"verdict":"approved","passed":["a","b"],"failed":[]},"cost_usd":0.01,"duration_ms":1000.0,"usage":{"input_tokens":100,"output_tokens":50}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        let structured = parsed
            .structured_output
            .expect("structured_output should be populated");
        assert_eq!(structured["verdict"], serde_json::json!("approved"));
        assert_eq!(structured["passed"], serde_json::json!(["a", "b"]));
        assert_eq!(structured["failed"], serde_json::json!([]));
    }

    #[test]
    fn parse_result_without_structured_output_field_is_none() {
        let line = r#"{"type":"result","result":"Done","cost_usd":0.01,"duration_ms":1000.0,"usage":{"input_tokens":100,"output_tokens":50}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse result line");
        assert!(parsed.structured_output.is_none());
    }

    #[test]
    fn parse_json_with_extra_unknown_fields_still_works() {
        let line = r#"{"type":"result","subtype":"success","totally_new_field":"whatever","cost_usd":0.005,"duration_ms":3000.0,"usage":{"input_tokens":2000,"output_tokens":1000,"cache_creation_input_tokens":100}}"#;

        let parsed = parse_stream_json_line(line).expect("should parse despite extra fields");
        let metrics = parsed.metrics.expect("should have metrics");
        assert_eq!(metrics.input_tokens, 2000);
        assert_eq!(metrics.output_tokens, 1000);
        assert!((metrics.cost_usd - 0.005).abs() < f64::EPSILON);
        assert_eq!(metrics.duration_ms, 3000);
    }

    // ===== parse_stream_json_init_line tests =====

    #[test]
    fn parse_init_line_with_string_tools_array_extracts_session_and_tools() {
        let line = r#"{"type":"system","subtype":"init","session_id":"sess-1","tools":["Bash","Read","StructuredOutput"]}"#;
        let init = parse_stream_json_init_line(line).expect("should parse init line");
        assert_eq!(init.session_id.as_deref(), Some("sess-1"));
        assert_eq!(
            init.tools,
            serde_json::json!(["Bash", "Read", "StructuredOutput"])
        );
        assert!(init.structured_output_advertised());
    }

    #[test]
    fn parse_init_line_with_object_tools_array_detects_structured_output() {
        let line = r#"{"type":"system","subtype":"init","session_id":"sess-2","tools":[{"name":"Bash"},{"name":"StructuredOutput","description":"x"}]}"#;
        let init = parse_stream_json_init_line(line).expect("should parse init line");
        assert!(init.structured_output_advertised());
    }

    #[test]
    fn parse_init_line_without_structured_output_returns_false() {
        let line =
            r#"{"type":"system","subtype":"init","session_id":"sess-3","tools":["Bash","Read"]}"#;
        let init = parse_stream_json_init_line(line).expect("should parse init line");
        assert!(!init.structured_output_advertised());
    }

    #[test]
    fn parse_init_line_returns_none_for_non_init_system_message() {
        // Other system subtypes (e.g. "stats") must not be parsed as init.
        let line = r#"{"type":"system","subtype":"stats","session_id":"sess-4"}"#;
        assert!(parse_stream_json_init_line(line).is_none());
    }

    #[test]
    fn parse_init_line_returns_none_for_result_line() {
        let line = r#"{"type":"result","result":"done"}"#;
        assert!(parse_stream_json_init_line(line).is_none());
    }

    #[test]
    fn parse_init_line_returns_none_for_malformed_json() {
        assert!(parse_stream_json_init_line("not json").is_none());
        assert!(parse_stream_json_init_line(r#"{"type":"system",broken"#).is_none());
        assert!(parse_stream_json_init_line("").is_none());
    }

    // ===== stream-json session log persistence classification tests =====

    #[test]
    fn classify_thinking_tokens_as_ephemeral_by_session() {
        let parsed = parse_stream_log_line(
            r#"{"type":"system","subtype":"thinking_tokens","session_id":"sess-1"}"#,
        )
        .expect("line should parse");

        assert_eq!(
            classify_stream_log_line(&parsed),
            StreamLogPersistence::Ephemeral {
                logical_key: "thinking:sess-1".to_string()
            }
        );
    }

    #[test]
    fn repeated_thinking_token_snapshots_share_one_logical_key() {
        let logical_keys: std::collections::HashSet<_> = (0..50)
            .map(|tokens| {
                let raw = format!(
                    r#"{{"type":"system","subtype":"thinking_tokens","session_id":"sess-1","tokens":{tokens}}}"#
                );
                let parsed = parse_stream_log_line(&raw).expect("line should parse");
                match classify_stream_log_line(&parsed) {
                    StreamLogPersistence::Ephemeral { logical_key } => logical_key,
                    StreamLogPersistence::Durable => panic!("thinking_tokens should be ephemeral"),
                }
            })
            .collect();

        assert_eq!(logical_keys.len(), 1);
        assert!(logical_keys.contains("thinking:sess-1"));
    }

    #[test]
    fn classify_task_progress_as_ephemeral_by_tool_use() {
        let parsed = parse_stream_log_line(
            r#"{"type":"system","subtype":"task_progress","tool_use_id":"toolu-1"}"#,
        )
        .expect("line should parse");

        assert_eq!(
            classify_stream_log_line(&parsed),
            StreamLogPersistence::Ephemeral {
                logical_key: "task_progress:toolu-1".to_string()
            }
        );
    }

    #[test]
    fn classify_rate_limit_event_as_ephemeral_by_session() {
        let parsed = parse_stream_log_line(
            r#"{"type":"rate_limit_event","session_id":"sess-2","limit":"tokens"}"#,
        )
        .expect("line should parse");

        assert_eq!(
            classify_stream_log_line(&parsed),
            StreamLogPersistence::Ephemeral {
                logical_key: "rate_limit:sess-2".to_string()
            }
        );
    }

    #[test]
    fn classify_unknown_types_and_subtypes_as_durable() {
        for raw in [
            r#"{"type":"assistant","session_id":"sess-1"}"#,
            r#"{"type":"user","session_id":"sess-1"}"#,
            r#"{"type":"result","session_id":"sess-1"}"#,
            r#"{"type":"system","subtype":"init","session_id":"sess-1"}"#,
            r#"{"type":"system","subtype":"future_snapshot","session_id":"sess-1"}"#,
            r#"{"type":"future_event","session_id":"sess-1"}"#,
        ] {
            let parsed = parse_stream_log_line(raw).expect("line should parse");
            assert_eq!(
                classify_stream_log_line(&parsed),
                StreamLogPersistence::Durable
            );
        }
    }

    #[test]
    fn classify_missing_key_fields_as_durable() {
        for raw in [
            r#"{"type":"system","subtype":"thinking_tokens"}"#,
            r#"{"type":"system","subtype":"thinking_tokens","session_id":""}"#,
            r#"{"type":"system","subtype":"task_progress"}"#,
            r#"{"type":"system","subtype":"task_progress","tool_use_id":""}"#,
            r#"{"type":"rate_limit_event"}"#,
            r#"{"type":"rate_limit_event","session_id":""}"#,
        ] {
            let parsed = parse_stream_log_line(raw).expect("line should parse");
            assert_eq!(
                classify_stream_log_line(&parsed),
                StreamLogPersistence::Durable
            );
        }
    }

    #[test]
    fn parse_stream_log_line_returns_none_for_malformed_json() {
        assert!(parse_stream_log_line("not json").is_none());
        assert!(parse_stream_log_line(r#"{"type":"system",broken"#).is_none());
    }
}
