use super::*;

#[test]
fn local_chat_event_names_match_public_contract() {
    let events = [
        LocalChatEvent::Init(LocalChatSessionInitEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            provider_resume_id: Some("conversation-1".to_string()),
            model: "sonnet".to_string(),
            tools: vec!["Read".to_string()],
        }),
        LocalChatEvent::Text(LocalChatTextEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            text: "hello".to_string(),
            is_partial: true,
        }),
        LocalChatEvent::ToolCall(LocalChatToolCallEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            input: "{}".to_string(),
            parent_tool_use_id: None,
        }),
        LocalChatEvent::ToolResult(LocalChatToolResultEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            tool_id: "tool-1".to_string(),
            result: "ok".to_string(),
            is_error: false,
            parent_tool_use_id: Some("parent-1".to_string()),
        }),
        LocalChatEvent::Usage(LocalChatSessionUsageEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            model: "sonnet".to_string(),
            context_tokens: 42,
            context_window: 200_000,
        }),
        LocalChatEvent::End(LocalChatSessionEndEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            duration_ms: 123,
            cost_usd: 0.25,
            num_turns: 2,
            result: "done".to_string(),
            is_error: false,
            context_tokens: 0,
            context_window: 200_000,
        }),
        LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            error: "boom".to_string(),
        }),
        LocalChatEvent::Warning(LocalChatSessionWarningEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            warning: "careful".to_string(),
        }),
    ];

    let names: Vec<_> = events
        .iter()
        .map(LocalChatEvent::tauri_event_name)
        .collect();
    assert_eq!(
        names,
        vec![
            "local-chat-session-init-event",
            "local-chat-text-event",
            "local-chat-tool-call-event",
            "local-chat-tool-result-event",
            "local-chat-session-usage-event",
            "local-chat-session-end-event",
            "local-chat-session-error-event",
            "local-chat-session-warning-event",
        ]
    );
}

#[test]
fn claude_neutral_events_map_to_compatibility_payloads() {
    let init = LocalChatEvent::Init(LocalChatSessionInitEvent {
        backend_session_id: "backend-1".to_string(),
        harness: LocalChatHarnessKind::Claude,
        provider_resume_id: Some("claude-conversation-1".to_string()),
        model: "sonnet".to_string(),
        tools: vec!["Read".to_string(), "Edit".to_string()],
    });
    match init.claude_compatibility_event() {
        Some(ClaudeCompatibilityEvent::Init(payload)) => {
            assert_eq!(payload.session_id, "backend-1");
            assert_eq!(
                payload.claude_conversation_id,
                Some("claude-conversation-1".to_string())
            );
            assert_eq!(payload.model, "sonnet");
            assert_eq!(payload.tools, vec!["Read", "Edit"]);
        }
        other => panic!("expected Claude init compatibility event, got {other:?}"),
    }

    let tool_call = LocalChatEvent::ToolCall(LocalChatToolCallEvent {
        backend_session_id: "backend-1".to_string(),
        harness: LocalChatHarnessKind::Claude,
        tool_id: "toolu_1".to_string(),
        tool_name: "Read".to_string(),
        input: r#"{"file_path":"README.md"}"#.to_string(),
        parent_tool_use_id: Some("parent-1".to_string()),
    });
    match tool_call.claude_compatibility_event() {
        Some(ClaudeCompatibilityEvent::ToolCall(payload)) => {
            assert_eq!(payload.session_id, "backend-1");
            assert_eq!(payload.tool_id, "toolu_1");
            assert_eq!(payload.tool_name, "Read");
            assert_eq!(payload.input, r#"{"file_path":"README.md"}"#);
            assert_eq!(payload.parent_tool_use_id, Some("parent-1".to_string()));
        }
        other => panic!("expected Claude tool call compatibility event, got {other:?}"),
    }

    let end = LocalChatEvent::End(LocalChatSessionEndEvent {
        backend_session_id: "backend-1".to_string(),
        harness: LocalChatHarnessKind::Claude,
        duration_ms: 500,
        cost_usd: 0.01,
        num_turns: 3,
        result: "complete".to_string(),
        is_error: false,
        context_tokens: 120,
        context_window: 200_000,
    });
    match end.claude_compatibility_event() {
        Some(ClaudeCompatibilityEvent::End(payload)) => {
            assert_eq!(payload.session_id, "backend-1");
            assert_eq!(payload.duration_ms, 500);
            assert_eq!(payload.cost_usd, 0.01);
            assert_eq!(payload.num_turns, 3);
            assert_eq!(payload.result, "complete");
            assert!(!payload.is_error);
            assert_eq!(payload.context_tokens, 120);
            assert_eq!(payload.context_window, 200_000);
        }
        other => panic!("expected Claude end compatibility event, got {other:?}"),
    }
}

#[test]
fn non_claude_events_do_not_mirror_to_claude_payloads() {
    let event = LocalChatEvent::Text(LocalChatTextEvent {
        backend_session_id: "codex-backend".to_string(),
        harness: LocalChatHarnessKind::Codex,
        text: "hello".to_string(),
        is_partial: false,
    });

    assert!(event.claude_compatibility_event().is_none());
}
