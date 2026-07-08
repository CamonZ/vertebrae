use super::*;
use crate::local_chat::harnesses::claude::jsonl::{
    InitEvent, SessionEndEvent, TextEvent, ToolCallEvent, ToolResultEvent, UsageEvent,
};
use crate::local_chat::harnesses::claude::live_jsonl::{
    ClaudeLiveJsonlExitReason, ClaudeLiveJsonlRunResult,
};

#[test]
fn maps_claude_init_to_neutral_local_chat_init() {
    let event =
        ClaudeSessionRuntime::local_chat_event_from_claude_emitted(EmittedEvent::Init(InitEvent {
            session_id: "backend-1".to_string(),
            claude_conversation_id: Some("conversation-1".to_string()),
            model: "claude-sonnet-4".to_string(),
            tools: vec!["Read".to_string(), "Edit".to_string()],
        }));

    assert_eq!(
        event,
        LocalChatEvent::Init(NeutralSessionInitEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            provider_resume_id: Some("conversation-1".to_string()),
            model: "claude-sonnet-4".to_string(),
            tools: vec!["Read".to_string(), "Edit".to_string()],
        })
    );
}

#[test]
fn maps_claude_text_and_tool_events_to_neutral_payloads() {
    let text =
        ClaudeSessionRuntime::local_chat_event_from_claude_emitted(EmittedEvent::Text(TextEvent {
            session_id: "backend-1".to_string(),
            text: "hello".to_string(),
            is_partial: true,
            parent_tool_use_id: Some("parent-tool".to_string()),
        }));
    assert_eq!(
        text,
        LocalChatEvent::Text(NeutralTextEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            text: "hello".to_string(),
            is_partial: true,
            parent_tool_use_id: Some("parent-tool".to_string()),
        })
    );

    let tool_call = ClaudeSessionRuntime::local_chat_event_from_claude_emitted(
        EmittedEvent::ToolCall(ToolCallEvent {
            session_id: "backend-1".to_string(),
            tool_id: "toolu_1".to_string(),
            tool_name: "Read".to_string(),
            input: r#"{"file_path":"README.md"}"#.to_string(),
            parent_tool_use_id: Some("parent-tool".to_string()),
        }),
    );
    assert_eq!(
        tool_call,
        LocalChatEvent::ToolCall(NeutralToolCallEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            tool_id: "toolu_1".to_string(),
            tool_name: "Read".to_string(),
            input: r#"{"file_path":"README.md"}"#.to_string(),
            parent_tool_use_id: Some("parent-tool".to_string()),
        })
    );

    let tool_result = ClaudeSessionRuntime::local_chat_event_from_claude_emitted(
        EmittedEvent::ToolResult(ToolResultEvent {
            session_id: "backend-1".to_string(),
            tool_id: "toolu_1".to_string(),
            result: "done".to_string(),
            is_error: false,
            parent_tool_use_id: Some("parent-tool".to_string()),
        }),
    );
    assert_eq!(
        tool_result,
        LocalChatEvent::ToolResult(NeutralToolResultEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            tool_id: "toolu_1".to_string(),
            result: "done".to_string(),
            is_error: false,
            parent_tool_use_id: Some("parent-tool".to_string()),
        })
    );
}

#[test]
fn maps_claude_usage_and_end_to_neutral_payloads() {
    let usage = ClaudeSessionRuntime::local_chat_event_from_claude_emitted(EmittedEvent::Usage(
        UsageEvent {
            session_id: "backend-1".to_string(),
            model: "claude-opus-4".to_string(),
            context_tokens: 1234,
            context_window: 200_000,
        },
    ));
    assert_eq!(
        usage,
        LocalChatEvent::Usage(NeutralSessionUsageEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            model: "claude-opus-4".to_string(),
            context_tokens: 1234,
            context_window: 200_000,
        })
    );

    let end = ClaudeSessionRuntime::local_chat_event_from_claude_emitted(EmittedEvent::SessionEnd(
        SessionEndEvent {
            session_id: "backend-1".to_string(),
            duration_ms: 5000,
            cost_usd: 0.42,
            num_turns: 3,
            result: "complete".to_string(),
            is_error: false,
            context_tokens: 4321,
            context_window: 200_000,
        },
    ));
    assert_eq!(
        end,
        LocalChatEvent::End(NeutralSessionEndEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            duration_ms: 5000,
            cost_usd: 0.42,
            num_turns: 3,
            result: "complete".to_string(),
            is_error: false,
            context_tokens: 4321,
            context_window: 200_000,
        })
    );
}

#[test]
fn stdout_close_without_session_end_emits_error_event() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let result = ClaudeLiveJsonlRunResult {
        exit_reason: ClaudeLiveJsonlExitReason::StdoutClosed,
        wait_status: None,
    };

    ClaudeSessionRuntime::emit_error_for_unexpected_runner_exit(&event_sink, "backend-1", &result);

    let captured_events = events
        .lock()
        .expect("local chat event capture lock should not be poisoned")
        .clone();
    assert_eq!(
        captured_events,
        vec![LocalChatEvent::Error(NeutralSessionErrorEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            error: "Claude session ended unexpectedly: stdout closed".to_string(),
        })]
    );
    assert!(!captured_events
        .iter()
        .any(|event| matches!(event, LocalChatEvent::End(_))));
}

#[test]
fn command_channel_close_without_session_end_emits_error_event() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let result = ClaudeLiveJsonlRunResult {
        exit_reason: ClaudeLiveJsonlExitReason::CommandChannelClosed,
        wait_status: None,
    };

    ClaudeSessionRuntime::emit_error_for_unexpected_runner_exit(&event_sink, "backend-1", &result);

    assert_eq!(
        events
            .lock()
            .expect("local chat event capture lock should not be poisoned")
            .as_slice(),
        &[LocalChatEvent::Error(NeutralSessionErrorEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            error: "Claude session ended unexpectedly: command channel closed".to_string(),
        })]
    );
}

#[test]
fn close_command_without_session_end_emits_no_terminal_event() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let result = ClaudeLiveJsonlRunResult {
        exit_reason: ClaudeLiveJsonlExitReason::CloseCommand,
        wait_status: None,
    };

    ClaudeSessionRuntime::emit_error_for_unexpected_runner_exit(&event_sink, "backend-1", &result);

    assert!(events
        .lock()
        .expect("local chat event capture lock should not be poisoned")
        .is_empty());
}

#[test]
fn stdout_close_after_prior_session_end_still_emits_error() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    ClaudeSessionRuntime::emit_jsonl_events(
        &event_sink,
        vec![EmittedEvent::SessionEnd(SessionEndEvent {
            session_id: "backend-1".to_string(),
            duration_ms: 1,
            cost_usd: 0.0,
            num_turns: 1,
            result: "turn complete".to_string(),
            is_error: false,
            context_tokens: 0,
            context_window: 200_000,
        })],
    );

    let result = ClaudeLiveJsonlRunResult {
        exit_reason: ClaudeLiveJsonlExitReason::StdoutClosed,
        wait_status: None,
    };

    ClaudeSessionRuntime::emit_error_for_unexpected_runner_exit(&event_sink, "backend-1", &result);

    assert_eq!(
        events
            .lock()
            .expect("local chat event capture lock should not be poisoned")
            .as_slice(),
        &[
            LocalChatEvent::End(NeutralSessionEndEvent {
                backend_session_id: "backend-1".to_string(),
                harness: LocalChatHarnessKind::Claude,
                duration_ms: 1,
                cost_usd: 0.0,
                num_turns: 1,
                result: "turn complete".to_string(),
                is_error: false,
                context_tokens: 0,
                context_window: 200_000,
            }),
            LocalChatEvent::Error(NeutralSessionErrorEvent {
                backend_session_id: "backend-1".to_string(),
                harness: LocalChatHarnessKind::Claude,
                error: "Claude session ended unexpectedly: stdout closed".to_string(),
            }),
        ]
    );
}
