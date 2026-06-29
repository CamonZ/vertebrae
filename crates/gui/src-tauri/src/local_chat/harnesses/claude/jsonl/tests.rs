use super::*;

// ========================================================================
// build_events tests
// ========================================================================

fn parse_msg(json: &str) -> ClaudeMessage {
    serde_json::from_str(json).expect("Failed to parse test ClaudeMessage JSON")
}

/// A reader that yields its data then returns errors forever.
/// Use this to test that processing stops on read error.
struct FailingReader {
    data: std::io::Cursor<Vec<u8>>,
    has_errored: bool,
}

impl FailingReader {
    fn new(data: &str) -> Self {
        Self {
            data: std::io::Cursor::new(data.as_bytes().to_vec()),
            has_errored: false,
        }
    }
}

impl std::io::Read for FailingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.has_errored {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        let n = std::io::Read::read(&mut self.data, buf)?;
        if n == 0 {
            self.has_errored = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        Ok(n)
    }
}

impl std::io::BufRead for FailingReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.has_errored {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        let buf = std::io::BufRead::fill_buf(&mut self.data)?;
        if buf.is_empty() {
            self.has_errored = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe broke",
            ));
        }
        Ok(buf)
    }

    fn consume(&mut self, amt: usize) {
        std::io::BufRead::consume(&mut self.data, amt);
    }
}

#[test]
fn test_process_jsonl_lines_parses_and_emits() {
    let input = concat!(
        r#"{"type":"system","subtype":"init","model":"claude-sonnet-4"}"#,
        "\n",
        r#"{"type":"result","duration_ms":100}"#,
        "\n",
    );

    let mut all_events = Vec::new();
    process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |events| {
        all_events.extend(events)
    });

    assert_eq!(all_events.len(), 2);
    assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
    assert!(matches!(&all_events[1], EmittedEvent::SessionEnd(_)));
}

#[test]
fn test_process_jsonl_lines_skips_empty_lines() {
    let input = concat!(
        r#"{"type":"system","subtype":"init"}"#,
        "\n",
        "\n",
        "\n",
        r#"{"type":"result"}"#,
        "\n",
    );

    let mut count = 0;
    process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |_| count += 1);

    // Two valid messages, empty lines skipped.
    assert_eq!(count, 2);
}

#[test]
fn test_process_jsonl_lines_skips_invalid_json() {
    let input = concat!(
        r#"{"type":"system","subtype":"init"}"#,
        "\n",
        "not valid json\n",
        r#"{"type":"result"}"#,
        "\n",
    );

    let mut all_events = Vec::new();
    process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |events| {
        all_events.extend(events)
    });

    // Only the two valid messages should produce events.
    assert_eq!(all_events.len(), 2);
}

#[test]
fn test_process_jsonl_lines_empty_input() {
    let mut called = false;
    process_jsonl_lines(std::io::Cursor::new(""), "sess-1", |_| called = true);
    assert!(!called);
}

#[test]
fn test_process_jsonl_lines_stops_on_read_error() {
    let input = format!("{}\n", r#"{"type":"system","subtype":"init"}"#);
    let reader = FailingReader::new(&input);

    let mut all_events = Vec::new();
    process_jsonl_lines(reader, "sess-1", |events| all_events.extend(events));

    // Should have processed the one valid line before the error.
    assert_eq!(all_events.len(), 1);
    assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
}

#[test]
fn test_build_events_system_init() {
    let msg = parse_msg(
        r#"{
            "type": "system",
            "subtype": "init",
            "session_id": "conv-abc",
            "uuid": "uuid-123",
            "model": "claude-sonnet-4",
            "tools": ["Read", "Edit"]
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Init(e) => {
            assert_eq!(e.session_id, "sess-1");
            // session_id takes precedence over uuid
            assert_eq!(e.claude_conversation_id, Some("conv-abc".to_string()));
            assert_eq!(e.model, "claude-sonnet-4");
            assert_eq!(e.tools, vec!["Read", "Edit"]);
        }
        other => panic!("Expected Init event, got {:?}", other),
    }
}

#[test]
fn test_build_events_system_init_fallback_to_uuid() {
    let msg = parse_msg(
        r#"{
            "type": "system",
            "subtype": "init",
            "uuid": "uuid-123",
            "model": "claude-sonnet-4"
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Init(e) => {
            assert_eq!(e.claude_conversation_id, Some("uuid-123".to_string()));
        }
        other => panic!("Expected Init event, got {:?}", other),
    }
}

#[test]
fn test_build_events_system_non_init() {
    let msg = parse_msg(r#"{"type": "system", "subtype": "other"}"#);
    let events = build_events("sess-1", msg);
    assert!(events.is_empty());
}

#[test]
fn test_build_events_system_no_subtype() {
    let msg = parse_msg(r#"{"type": "system"}"#);
    let events = build_events("sess-1", msg);
    assert!(events.is_empty());
}

#[test]
fn test_build_events_stream_event_text_delta() {
    let msg = parse_msg(
        r#"{
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {
                    "type": "text_delta",
                    "text": "Hello"
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Text(e) => {
            assert_eq!(e.session_id, "sess-1");
            assert_eq!(e.text, "Hello");
            assert!(e.is_partial);
        }
        other => panic!("Expected Text event, got {:?}", other),
    }
}

#[test]
fn test_build_events_stream_event_non_text_delta_type() {
    let msg = parse_msg(
        r#"{
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {
                    "type": "input_json_delta",
                    "text": "ignored"
                }
            }
        }"#,
    );
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_stream_event_non_delta_event() {
    let msg = parse_msg(
        r#"{
            "type": "stream_event",
            "event": {
                "type": "content_block_start"
            }
        }"#,
    );
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_stream_event_no_event_field() {
    let msg = parse_msg(r#"{"type": "stream_event"}"#);
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_stream_event_message_delta_usage() {
    let msg = parse_msg(
        r#"{
            "type": "stream_event",
            "model": "claude-sonnet-4-6-latest",
            "event": {
                "type": "message_delta",
                "usage": {
                    "input_tokens": 25,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 50,
                    "output_tokens": 12
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Usage(e) => {
            assert_eq!(e.session_id, "sess-1");
            assert_eq!(e.model, "claude-sonnet-4-6-latest");
            assert_eq!(e.context_tokens, 175);
            assert_eq!(e.context_window, 200_000);
        }
        other => panic!("Expected Usage event, got {:?}", other),
    }
}

#[test]
fn test_build_events_stream_event_sidechain_message_delta_usage_is_skipped() {
    let msg = parse_msg(
        r#"{
            "type": "stream_event",
            "parent_tool_use_id": "toolu_AGENT",
            "model": "claude-haiku-4-5-20251001",
            "event": {
                "type": "message_delta",
                "usage": {
                    "input_tokens": 1,
                    "cache_read_input_tokens": 2,
                    "cache_creation_input_tokens": 3,
                    "output_tokens": 4
                }
            }
        }"#,
    );

    assert!(
        build_events("sess-1", msg).is_empty(),
        "sidechain message_delta usage must not update the main context meter"
    );
}

#[test]
fn test_build_events_content_block_delta_direct() {
    let msg = parse_msg(
        r#"{
            "type": "content_block_delta",
            "delta": {
                "type": "text_delta",
                "text": "World"
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Text(e) => {
            assert_eq!(e.text, "World");
            assert!(e.is_partial);
        }
        other => panic!("Expected Text event, got {:?}", other),
    }
}

#[test]
fn test_build_events_content_block_delta_non_text() {
    let msg = parse_msg(
        r#"{
            "type": "content_block_delta",
            "delta": {"type": "input_json_delta"}
        }"#,
    );
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_content_block_start_stop_are_noop() {
    let msg = parse_msg(r#"{"type": "content_block_start"}"#);
    assert!(build_events("sess-1", msg).is_empty());

    let msg = parse_msg(r#"{"type": "content_block_stop"}"#);
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_assistant_text() {
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Hello from Claude"}
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::Text(e) => {
            assert_eq!(e.text, "Hello from Claude");
            assert!(!e.is_partial);
        }
        other => panic!("Expected Text event, got {:?}", other),
    }
}

#[test]
fn test_build_events_assistant_tool_use() {
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_123",
                        "name": "Read",
                        "input": {"file_path": "/test.txt"}
                    }
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::ToolCall(e) => {
            assert_eq!(e.tool_id, "toolu_123");
            assert_eq!(e.tool_name, "Read");
            assert!(e.input.contains("file_path"));
        }
        other => panic!("Expected ToolCall event, got {:?}", other),
    }
}

#[test]
fn test_build_events_assistant_mixed_content() {
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me read that"},
                    {"type": "tool_use", "id": "toolu_456", "name": "Read", "input": {}}
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], EmittedEvent::Text(_)));
    assert!(matches!(&events[1], EmittedEvent::ToolCall(_)));
}

#[test]
fn test_build_events_assistant_no_message() {
    let msg = parse_msg(r#"{"type": "assistant"}"#);
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_user_tool_result() {
    let msg = parse_msg(
        r#"{
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_123",
                        "content": "file contents here",
                        "is_error": false
                    }
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::ToolResult(e) => {
            assert_eq!(e.tool_id, "toolu_123");
            assert_eq!(e.result, "file contents here");
            assert!(!e.is_error);
        }
        other => panic!("Expected ToolResult event, got {:?}", other),
    }
}

#[test]
fn test_build_events_user_tool_result_error() {
    let msg = parse_msg(
        r#"{
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_err",
                        "content": "something broke",
                        "is_error": true
                    }
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::ToolResult(e) => {
            assert!(e.is_error);
            assert_eq!(e.result, "something broke");
        }
        other => panic!("Expected ToolResult event, got {:?}", other),
    }
}

#[test]
fn test_build_events_user_tool_result_json_content() {
    let msg = parse_msg(
        r#"{
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_json",
                        "content": {"key": "value"},
                        "is_error": false
                    }
                ]
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::ToolResult(e) => {
            assert!(e.result.contains("key"));
            assert!(e.result.contains("value"));
        }
        other => panic!("Expected ToolResult event, got {:?}", other),
    }
}

#[test]
fn test_build_events_assistant_emits_usage_event() {
    // Per-turn usage event should fire whenever the assistant message
    // carries a `usage` block. Cached input tokens still occupy the
    // request context, so they are included in the context-size figure.
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "model": "claude-opus-4-7-20250115",
                "content": [{"type": "text", "text": "hi"}],
                "usage": {
                    "input_tokens": 50,
                    "cache_read_input_tokens": 100000,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 25
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 2, "expected Usage + Text events");
    match &events[0] {
        EmittedEvent::Usage(e) => {
            assert_eq!(e.session_id, "sess-1");
            assert_eq!(e.model, "claude-opus-4-7-20250115");
            assert_eq!(e.context_tokens, 100_050);
            assert_eq!(e.context_window, 200_000);
        }
        other => panic!("Expected Usage event first, got {:?}", other),
    }
    assert!(matches!(&events[1], EmittedEvent::Text(_)));
}

#[test]
fn test_build_events_assistant_usage_includes_cache_creation_tokens() {
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "model": "claude-sonnet-4-6-latest",
                "content": [{"type": "text", "text": "hi"}],
                "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 30,
                    "cache_creation_input_tokens": 40,
                    "output_tokens": 20
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 2, "expected Usage + Text events");
    match &events[0] {
        EmittedEvent::Usage(e) => {
            assert_eq!(e.model, "claude-sonnet-4-6-latest");
            assert_eq!(e.context_tokens, 80);
            assert_eq!(e.context_window, 200_000);
        }
        other => panic!("Expected Usage event first, got {:?}", other),
    }
}

#[test]
fn test_build_events_assistant_sidechain_usage_is_skipped() {
    // Sub-agent (sidechain) messages carry `parent_tool_use_id` and run
    // with their own context lineage. Their usage must NOT emit a context
    // event, or the meter lurches to the sub-agent's (often much smaller,
    // cache-cold) context size mid-turn.
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "parent_tool_use_id": "toolu_015MUSNfZRk8PAxfmiznzBxt",
            "message": {
                "role": "assistant",
                "model": "claude-haiku-4-5-20251001",
                "content": [{"type": "text", "text": "searching"}],
                "usage": {
                    "input_tokens": 3,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 8415,
                    "output_tokens": 12
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1, "sidechain usage must not be emitted");
    assert!(
        matches!(&events[0], EmittedEvent::Text(_)),
        "expected only the Text event, got {:?}",
        events[0]
    );
}

#[test]
fn test_build_events_propagates_parent_tool_use_id() {
    // A sub-agent tool call carries parent_tool_use_id so the UI can nest it
    // under the spawning Task tool. Main-thread calls carry None.
    let sidechain = parse_msg(
        r#"{
            "type": "assistant",
            "parent_tool_use_id": "toolu_AGENT",
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "toolu_child", "name": "Read", "input": {}}]
            }
        }"#,
    );
    let events = build_events("s", sidechain);
    match events
        .iter()
        .find(|e| matches!(e, EmittedEvent::ToolCall(_)))
    {
        Some(EmittedEvent::ToolCall(e)) => {
            assert_eq!(e.parent_tool_use_id.as_deref(), Some("toolu_AGENT"));
        }
        _ => panic!("expected ToolCall event"),
    }

    let main = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "toolu_main", "name": "Read", "input": {}}]
            }
        }"#,
    );
    match build_events("s", main)
        .into_iter()
        .find(|e| matches!(e, EmittedEvent::ToolCall(_)))
    {
        Some(EmittedEvent::ToolCall(e)) => assert_eq!(e.parent_tool_use_id, None),
        _ => panic!("expected ToolCall event"),
    }

    // tool_result on a sidechain user message carries the parent too.
    let result = parse_msg(
        r#"{
            "type": "user",
            "parent_tool_use_id": "toolu_AGENT",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_child", "content": "ok", "is_error": false}]
            }
        }"#,
    );
    match build_events("s", result)
        .into_iter()
        .find(|e| matches!(e, EmittedEvent::ToolResult(_)))
    {
        Some(EmittedEvent::ToolResult(e)) => {
            assert_eq!(e.parent_tool_use_id.as_deref(), Some("toolu_AGENT"))
        }
        _ => panic!("expected ToolResult event"),
    }
}

#[test]
fn test_build_events_assistant_no_usage_no_event() {
    // When `usage` is absent, no Usage event is emitted.
    let msg = parse_msg(
        r#"{
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}]
            }
        }"#,
    );
    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    assert!(matches!(&events[0], EmittedEvent::Text(_)));
}

#[test]
fn test_build_events_result_with_usage() {
    let msg = parse_msg(
        r#"{
            "type": "result",
            "duration_ms": 5000,
            "num_turns": 3,
            "total_cost_usd": 0.05,
            "result": "Task completed",
            "is_error": false,
            "modelUsage": {
                "claude-sonnet-4": {
                    "inputTokens": 1000,
                    "outputTokens": 500,
                    "cacheReadInputTokens": 200,
                    "cacheCreationInputTokens": 100,
                    "contextWindow": 200000
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => {
            assert_eq!(e.session_id, "sess-1");
            assert_eq!(e.duration_ms, 5000);
            assert_eq!(e.num_turns, 3);
            assert_eq!(e.cost_usd, 0.05);
            assert_eq!(e.result, "Task completed");
            assert!(!e.is_error);
            // modelUsage is a cumulative session summary, not a usable
            // point-in-time context size, so SessionEnd reports 0 tokens
            // and only surfaces the model's context window.
            assert_eq!(e.context_tokens, 0);
            assert_eq!(e.context_window, 200_000);
        }
        other => panic!("Expected SessionEnd event, got {:?}", other),
    }
}

#[test]
fn test_build_events_result_no_usage() {
    let msg = parse_msg(
        r#"{
            "type": "result",
            "duration_ms": 1000,
            "result": "Done"
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => {
            assert_eq!(e.context_tokens, 0);
            assert_eq!(e.context_window, 200_000);
            assert_eq!(e.duration_ms, 1000);
        }
        other => panic!("Expected SessionEnd event, got {:?}", other),
    }
}

#[test]
fn test_build_events_result_is_error() {
    let msg = parse_msg(
        r#"{
            "type": "result",
            "result": "Something went wrong",
            "is_error": true
        }"#,
    );

    let events = build_events("sess-1", msg);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => {
            assert!(e.is_error);
            assert_eq!(e.result, "Something went wrong");
        }
        other => panic!("Expected SessionEnd event, got {:?}", other),
    }
}

#[test]
fn test_build_events_result_reports_window_not_cumulative_tokens() {
    // modelUsage token counts are cumulative session totals, not a
    // point-in-time context size, so SessionEnd never derives
    // context_tokens from them — it stays 0 and only the window is carried.
    let msg = parse_msg(
        r#"{
            "type": "result",
            "modelUsage": {
                "model-x": {
                    "inputTokens": 10,
                    "outputTokens": 20,
                    "cacheReadInputTokens": 30,
                    "cacheCreationInputTokens": 40,
                    "contextWindow": 100000
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => {
            assert_eq!(e.context_tokens, 0);
            assert_eq!(e.context_window, 100_000);
        }
        other => panic!("Expected SessionEnd event, got {:?}", other),
    }
}

#[test]
fn test_build_events_result_picks_largest_context_window_deterministically() {
    // With multiple models in modelUsage, the largest reported window wins
    // (deterministic regardless of HashMap order); context_tokens stays 0.
    let msg = parse_msg(
        r#"{
            "type": "result",
            "modelUsage": {
                "model-a": {
                    "inputTokens": 10,
                    "outputTokens": 999,
                    "cacheReadInputTokens": 20,
                    "cacheCreationInputTokens": 30,
                    "contextWindow": 200000
                },
                "model-b": {
                    "inputTokens": 100,
                    "outputTokens": 999,
                    "cacheReadInputTokens": 200,
                    "cacheCreationInputTokens": 300,
                    "contextWindow": 1000000
                }
            }
        }"#,
    );

    let events = build_events("sess-1", msg);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => {
            assert_eq!(e.context_tokens, 0);
            assert_eq!(e.context_window, 1_000_000);
        }
        other => panic!("Expected SessionEnd event, got {:?}", other),
    }
}

#[test]
fn test_build_events_unknown_type() {
    let msg = parse_msg(r#"{"type": "unknown_type"}"#);
    assert!(build_events("sess-1", msg).is_empty());
}

#[test]
fn test_build_events_session_id_propagation() {
    // Verify the session_id parameter is correctly set on all event types
    let test_sid = "my-unique-session-42";

    let msg = parse_msg(r#"{"type": "system", "subtype": "init"}"#);
    let events = build_events(test_sid, msg);
    match &events[0] {
        EmittedEvent::Init(e) => assert_eq!(e.session_id, test_sid),
        other => panic!("Expected Init, got {:?}", other),
    }

    let msg = parse_msg(
        r#"{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "x"}}"#,
    );
    let events = build_events(test_sid, msg);
    match &events[0] {
        EmittedEvent::Text(e) => assert_eq!(e.session_id, test_sid),
        other => panic!("Expected Text, got {:?}", other),
    }

    let msg = parse_msg(r#"{"type": "result"}"#);
    let events = build_events(test_sid, msg);
    match &events[0] {
        EmittedEvent::SessionEnd(e) => assert_eq!(e.session_id, test_sid),
        other => panic!("Expected SessionEnd, got {:?}", other),
    }
}
