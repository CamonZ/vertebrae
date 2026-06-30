use super::*;
use crate::local_chat::LocalChatSessionError;

#[test]
fn test_claude_session_runtime_new() {
    let runtime = ClaudeSessionRuntime::new();
    assert_eq!(runtime.sessions.blocking_read().len(), 0);
}

#[test]
fn test_claude_session_runtime_default() {
    let runtime = ClaudeSessionRuntime::default();
    assert_eq!(runtime.sessions.blocking_read().len(), 0);
}

#[tokio::test]
async fn test_has_session_empty() {
    let runtime = ClaudeSessionRuntime::new();
    assert!(!runtime.has_session("non-existent").await);
}

#[tokio::test]
async fn test_send_message_session_not_found() {
    let runtime = ClaudeSessionRuntime::new();
    let result = runtime.send_message("non-existent", "test").await;
    assert!(result.is_err());
    match result {
        Err(LocalChatSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
        _ => panic!("Expected SessionNotFound error"),
    }
}

#[tokio::test]
async fn test_close_session_not_found() {
    let runtime = ClaudeSessionRuntime::new();
    let result = runtime.close_session("non-existent").await;
    assert!(result.is_err());
    match result {
        Err(LocalChatSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
        _ => panic!("Expected SessionNotFound error"),
    }
}

#[test]
fn test_local_chat_session_error_display() {
    let err = LocalChatSessionError::SessionNotFound("test-123".to_string());
    assert_eq!(err.to_string(), "Session not found: test-123");

    let err = LocalChatSessionError::SessionExists("test-456".to_string());
    assert_eq!(err.to_string(), "Session already exists: test-456");

    let err = LocalChatSessionError::SendFailed("IO error".to_string());
    assert_eq!(err.to_string(), "Failed to send message: IO error");
}

#[tokio::test]
async fn test_has_session_existing() {
    let runtime = ClaudeSessionRuntime::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut sessions = runtime.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    assert!(runtime.has_session("test-session").await);
    assert!(!runtime.has_session("other-session").await);
}

#[tokio::test]
async fn test_send_message_channel_dropped() {
    let runtime = ClaudeSessionRuntime::new();
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    {
        let mut sessions = runtime.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    let result = runtime.send_message("test-session", "hello").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_close_session_channel_dropped() {
    let runtime = ClaudeSessionRuntime::new();
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    {
        let mut sessions = runtime.sessions.write().await;
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }
    let result = runtime.close_session("test-session").await;
    assert!(result.is_err());
}

#[test]
fn test_session_cleanup_removes_registry_handle() {
    let runtime = ClaudeSessionRuntime::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    {
        let mut sessions = runtime.sessions.blocking_write();
        sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
    }

    {
        let _cleanup = SessionCleanup::new(
            "test-session".to_string(),
            runtime.sessions.clone(),
            PermissionBridge::new(),
        );
    }

    assert!(!runtime
        .sessions
        .blocking_read()
        .contains_key("test-session"));
}
