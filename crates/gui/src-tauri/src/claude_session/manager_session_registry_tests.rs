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
