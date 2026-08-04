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
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            text: "hello".to_string(),
            is_partial: true,
            parent_tool_use_id: None,
        }),
        LocalChatEvent::TurnStarted(LocalChatTurnStartedEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: "turn-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
        }),
        LocalChatEvent::ToolCall(LocalChatToolCallEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            input: "{}".to_string(),
            parent_tool_use_id: None,
        }),
        LocalChatEvent::ToolResult(LocalChatToolResultEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            tool_id: "tool-1".to_string(),
            result: "ok".to_string(),
            is_error: false,
            parent_tool_use_id: Some("parent-1".to_string()),
        }),
        LocalChatEvent::FileChange(LocalChatFileChangeEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            tool_id: "file-1".to_string(),
            status: "completed".to_string(),
            changes: vec![LocalChatFileChange {
                path: "src/lib.rs".to_string(),
                kind: "update".to_string(),
                diff: Some("@@".to_string()),
            }],
            parent_tool_use_id: None,
        }),
        LocalChatEvent::Usage(LocalChatSessionUsageEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            model: "sonnet".to_string(),
            context_tokens: 42,
            context_window: 200_000,
            thread_total_tokens: 100,
        }),
        LocalChatEvent::End(LocalChatSessionEndEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: "turn-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
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
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            error: "boom".to_string(),
        }),
        LocalChatEvent::Warning(LocalChatSessionWarningEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            warning: "careful".to_string(),
        }),
        LocalChatEvent::Compaction(LocalChatCompactionEvent {
            backend_session_id: "session-1".to_string(),
            harness: LocalChatHarnessKind::Claude,
            turn_id: Some("turn-1".to_string()),
            thread_id: Some("thread-1".to_string()),
            is_root: true,
            state: "active".to_string(),
            trigger: None,
            pre_tokens: None,
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
            "local-chat-turn-started-event",
            "local-chat-tool-call-event",
            "local-chat-tool-result-event",
            "local-chat-file-change-event",
            "local-chat-session-usage-event",
            "local-chat-session-end-event",
            "local-chat-session-error-event",
            "local-chat-session-warning-event",
            "local-chat-compaction-event",
        ]
    );
}
