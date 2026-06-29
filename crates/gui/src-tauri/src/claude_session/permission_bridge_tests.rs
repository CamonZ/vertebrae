use super::*;

#[test]
fn test_resolve_permission_request_sends_local_decision() {
    let manager = ClaudeSessionManager::new();
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    manager.pending_permissions.lock().unwrap().insert(
        "req-1".to_string(),
        PendingPermission {
            session_id: "session-1".to_string(),
            response_tx,
        },
    );

    let result = manager
        .resolve_permission_request(
            "req-1",
            LocalPermissionDecision {
                behavior: "allow".to_string(),
                message: None,
                updated_input: Some(serde_json::json!({ "command": "ls" })),
            },
        )
        .unwrap();

    assert_eq!(result["behavior"], "allow");
    assert!(manager.pending_permissions.lock().unwrap().is_empty());

    let decision = response_rx.recv().unwrap();
    assert_eq!(decision.behavior, "allow");
    assert_eq!(
        decision.updated_input,
        Some(serde_json::json!({ "command": "ls" }))
    );
}

#[test]
fn test_resolve_permission_request_requires_local_pending_request() {
    let manager = ClaudeSessionManager::new();
    let result = manager.resolve_permission_request(
        "missing",
        LocalPermissionDecision {
            behavior: "deny".to_string(),
            message: Some("Denied".to_string()),
            updated_input: None,
        },
    );

    assert!(result.unwrap_err().contains("Permission request not found"));
}

#[test]
fn test_fail_pending_permissions_for_session_sends_denials() {
    let pending_permissions = Arc::new(Mutex::new(HashMap::new()));
    let (session_a_tx_1, session_a_rx_1) = std::sync::mpsc::channel();
    let (session_a_tx_2, session_a_rx_2) = std::sync::mpsc::channel();
    let (session_b_tx, session_b_rx) = std::sync::mpsc::channel();

    {
        let mut pending = pending_permissions.lock().unwrap();
        pending.insert(
            "req-a-1".to_string(),
            PendingPermission {
                session_id: "session-a".to_string(),
                response_tx: session_a_tx_1,
            },
        );
        pending.insert(
            "req-a-2".to_string(),
            PendingPermission {
                session_id: "session-a".to_string(),
                response_tx: session_a_tx_2,
            },
        );
        pending.insert(
            "req-b".to_string(),
            PendingPermission {
                session_id: "session-b".to_string(),
                response_tx: session_b_tx,
            },
        );
    }

    ClaudeSessionManager::fail_pending_permissions_for_session(&pending_permissions, "session-a");

    for receiver in [session_a_rx_1, session_a_rx_2] {
        let decision = receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        assert_eq!(decision.behavior, "deny");
        assert_eq!(
            decision.message.as_deref(),
            Some("Claude session ended before the permission request was resolved")
        );
        assert!(decision.updated_input.is_none());
    }
    assert!(matches!(
        session_b_rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));

    let pending = pending_permissions.lock().unwrap();
    assert!(!pending.contains_key("req-a-1"));
    assert!(!pending.contains_key("req-a-2"));
    assert!(pending.contains_key("req-b"));
}

#[test]
fn test_local_permission_decision_serializes_for_claude_schema() {
    let allow = serde_json::to_value(LocalPermissionDecision {
        behavior: "allow".to_string(),
        message: None,
        updated_input: Some(serde_json::json!({ "command": "ls" })),
    })
    .unwrap();
    assert_eq!(
        allow,
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": { "command": "ls" }
        })
    );

    let deny = serde_json::to_value(LocalPermissionDecision {
        behavior: "deny".to_string(),
        message: Some("Denied from Vertebrae GUI".to_string()),
        updated_input: None,
    })
    .unwrap();
    assert_eq!(
        deny,
        serde_json::json!({
            "behavior": "deny",
            "message": "Denied from Vertebrae GUI"
        })
    );
}

#[cfg(unix)]
#[test]
fn test_prepare_permission_socket_directory_sets_private_mode() {
    use std::os::unix::fs::PermissionsExt;

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("vtbg-dir-test-{}-{suffix}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);

    ClaudeSessionManager::prepare_permission_socket_directory(&directory).unwrap();

    let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);

    std::fs::remove_dir(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn test_permission_socket_path_stays_under_unix_limit_for_long_session_ids() {
    use std::os::unix::ffi::OsStrExt;

    let session_id = "scoped-chat-1781971607649-bijgbrn-1781971734050-extra-long-session-suffix";
    let path = ClaudeSessionManager::permission_socket_path(session_id);
    let path_len = path.as_os_str().as_bytes().len();

    assert!(
        path_len < MAX_UNIX_SOCKET_PATH_BYTES,
        "socket path should fit Unix sockaddr limits: {:?} ({path_len} bytes)",
        path
    );
    assert!(
        !path.to_string_lossy().contains(session_id),
        "socket path should not embed the raw session id"
    );
}
