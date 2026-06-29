use super::*;

#[test]
fn test_claude_session_manager_new() {
    let manager = ClaudeSessionManager::new();
    assert_eq!(manager.sessions.blocking_read().len(), 0);
}

#[test]
fn test_claude_session_manager_default() {
    let manager = ClaudeSessionManager::default();
    assert_eq!(manager.sessions.blocking_read().len(), 0);
}

#[tokio::test]
async fn test_has_session_empty() {
    let manager = ClaudeSessionManager::new();
    assert!(!manager.has_session("non-existent").await);
}

#[tokio::test]
async fn test_send_message_session_not_found() {
    let manager = ClaudeSessionManager::new();
    let result = manager.send_message("non-existent", "test").await;
    assert!(result.is_err());
    match result {
        Err(ClaudeSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
        _ => panic!("Expected SessionNotFound error"),
    }
}

#[tokio::test]
async fn test_close_session_not_found() {
    let manager = ClaudeSessionManager::new();
    let result = manager.close_session("non-existent").await;
    assert!(result.is_err());
    match result {
        Err(ClaudeSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
        _ => panic!("Expected SessionNotFound error"),
    }
}

#[test]
fn test_claude_session_error_display() {
    let err = ClaudeSessionError::SessionNotFound("test-123".to_string());
    assert_eq!(err.to_string(), "Session not found: test-123");

    let err = ClaudeSessionError::SessionExists("test-456".to_string());
    assert_eq!(err.to_string(), "Session already exists: test-456");

    let err = ClaudeSessionError::SendFailed("IO error".to_string());
    assert_eq!(err.to_string(), "Failed to send message: IO error");
}

#[test]
fn test_event_serialization() {
    let init_event = ClaudeSessionInitEvent {
        session_id: "test-session".to_string(),
        claude_conversation_id: Some("conv-123".to_string()),
        model: "claude-sonnet-4".to_string(),
        tools: vec!["Read".to_string(), "Edit".to_string()],
    };
    let json = serde_json::to_string(&init_event).expect("Should serialize");
    assert!(json.contains("test-session"));
    assert!(json.contains("claude-sonnet-4"));
    assert!(json.contains("conv-123"));

    let text_event = ClaudeTextEvent {
        session_id: "test".to_string(),
        text: "Hello world".to_string(),
        is_partial: false,
    };
    let json = serde_json::to_string(&text_event).expect("Should serialize");
    assert!(json.contains("Hello world"));

    let tool_call_event = ClaudeToolCallEvent {
        session_id: "test".to_string(),
        tool_id: "toolu_123".to_string(),
        tool_name: "Read".to_string(),
        input: r#"{"file_path":"/test.txt"}"#.to_string(),
        parent_tool_use_id: None,
    };
    let json = serde_json::to_string(&tool_call_event).expect("Should serialize");
    assert!(json.contains("toolu_123"));
    assert!(json.contains("Read"));

    let end_event = ClaudeSessionEndEvent {
        session_id: "test".to_string(),
        duration_ms: 5000,
        cost_usd: 0.05,
        num_turns: 3,
        result: "Done".to_string(),
        is_error: false,
        context_tokens: 0,
        context_window: 0,
    };
    let json = serde_json::to_string(&end_event).expect("Should serialize");
    assert!(json.contains("5000"));
    assert!(json.contains("0.05"));
}

#[tokio::test]
async fn test_has_session_existing() {
    let manager = ClaudeSessionManager::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut sessions = manager.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    assert!(manager.has_session("test-session").await);
    assert!(!manager.has_session("other-session").await);
}

#[tokio::test]
async fn test_send_message_channel_dropped() {
    let manager = ClaudeSessionManager::new();
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    {
        let mut sessions = manager.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    let result = manager.send_message("test-session", "hello").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_close_session_channel_dropped() {
    let manager = ClaudeSessionManager::new();
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    {
        let mut sessions = manager.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    let result = manager.close_session("test-session").await;
    assert!(result.is_err());
}

#[test]
fn test_session_cleanup_removes_registry_handle() {
    let manager = ClaudeSessionManager::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut sessions = manager.sessions.blocking_write();
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }

    {
        let _cleanup = SessionCleanup::new(
            "test-session".to_string(),
            manager.sessions.clone(),
            manager.permission_bridge.clone(),
        );
    }

    assert!(!manager
        .sessions
        .blocking_read()
        .contains_key("test-session"));
}
