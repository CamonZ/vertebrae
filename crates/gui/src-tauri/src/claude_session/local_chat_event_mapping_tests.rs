use super::*;
use crate::local_chat::harnesses::claude::jsonl::{
    InitEvent, SessionEndEvent, TextEvent, ToolCallEvent, ToolResultEvent, UsageEvent,
};

#[test]
fn maps_claude_init_to_neutral_local_chat_init() {
    let event =
        ClaudeSessionManager::local_chat_event_from_claude_emitted(EmittedEvent::Init(InitEvent {
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
        ClaudeSessionManager::local_chat_event_from_claude_emitted(EmittedEvent::Text(TextEvent {
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

    let tool_call = ClaudeSessionManager::local_chat_event_from_claude_emitted(
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

    let tool_result = ClaudeSessionManager::local_chat_event_from_claude_emitted(
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
    let usage = ClaudeSessionManager::local_chat_event_from_claude_emitted(EmittedEvent::Usage(
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

    let end = ClaudeSessionManager::local_chat_event_from_claude_emitted(EmittedEvent::SessionEnd(
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
