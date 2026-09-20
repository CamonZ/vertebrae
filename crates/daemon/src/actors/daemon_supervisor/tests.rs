use super::*;

// ===== Test helpers =====

/// Build a PhoenixMessage for testing.
fn msg(topic: &str, event: &str, payload: serde_json::Value) -> PhoenixMessage {
    PhoenixMessage {
        join_ref: None,
        msg_ref: None,
        topic: topic.to_string(),
        event: event.to_string(),
        payload,
    }
}

/// Build a known-projects map containing the given project IDs.
/// Uses () as value since classify_channel_message is generic over the value type.
fn known_projects(ids: &[&str]) -> HashMap<String, ()> {
    ids.iter().map(|id| (id.to_string(), ())).collect()
}

// ===== classify_channel_message tests =====

#[test]
fn classify_project_channel_event_is_ignored() {
    let projects = known_projects(&["proj-1"]);
    let m = msg("project:proj-1", "task_created", serde_json::json!({}));
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::NonProjectTopic
    );
}

#[test]
fn classify_project_channel_join_reply_is_ignored() {
    let projects = known_projects(&["proj-1"]);
    let m = msg(
        "project:proj-1",
        "phx_reply",
        serde_json::json!({"status": "ok", "response": {}}),
    );
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::NonProjectTopic
    );
}

#[test]
fn classify_daemon_run_step_routes_by_payload_project() {
    let projects = known_projects(&["proj-1"]);
    let m = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "run_step",
        serde_json::json!({"project_id": "proj-1", "id": "execution-1", "task_id": "task-1"}),
    );
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::RouteDaemonToProject("proj-1".to_string())
    );
}

#[test]
fn classify_daemon_cancel_step_routes_by_payload_project() {
    let projects = known_projects(&["proj-1"]);
    let m = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "cancel_step",
        serde_json::json!({
            "project_id": "proj-1",
            "step_execution_id": "execution-1",
            "task_id": "task-1"
        }),
    );
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::RouteDaemonToProject("proj-1".to_string())
    );
}

#[test]
fn classify_rejects_messages_for_a_different_daemon() {
    let projects = known_projects(&["proj-1"]);
    let m = msg(
        "daemon:44444444-4444-4444-4444-444444444444",
        "run_step",
        serde_json::json!({"project_id": "proj-1", "id": "execution-1", "task_id": "task-1"}),
    );
    assert_eq!(
        classify_channel_message_with_join_ref(
            &m,
            &projects,
            None,
            Some("33333333-3333-3333-3333-333333333333"),
        ),
        ChannelAction::RejectedDaemonMessage(
            "message received for unauthenticated daemon 44444444-4444-4444-4444-444444444444"
                .to_string(),
        )
    );
}

#[test]
fn classify_standalone_join_success() {
    let projects = known_projects(&[]);
    let m = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "phx_reply",
        serde_json::json!({"status": "ok"}),
    );
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::DaemonJoinConfirmed("33333333-3333-3333-3333-333333333333".to_string())
    );
}

#[test]
fn classify_daemon_report_ack_without_restarting_the_publisher() {
    let projects = known_projects(&[]);
    let mut report_ack = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "phx_reply",
        serde_json::json!({"status": "ok", "response": {"accepted": true}}),
    );
    report_ack.msg_ref = Some("report-ref".to_string());
    assert_eq!(
        classify_channel_message_with_join_ref(&report_ack, &projects, Some("join-ref"), None),
        ChannelAction::DaemonMessageAcknowledged
    );
}

#[test]
fn classify_standalone_credential_rejection_as_permanent() {
    let projects = known_projects(&[]);
    let m = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "phx_reply",
        serde_json::json!({
            "status": "error",
            "response": {"reason": "invalid_credentials"}
        }),
    );
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::DaemonJoinFailed(
            "33333333-3333-3333-3333-333333333333".to_string(),
            Some("invalid_credentials".to_string())
        )
    );
}

#[test]
fn classify_standalone_not_found_and_deregistered_as_terminal_retirement() {
    let projects = known_projects(&[]);
    for reason in ["not_found", "deregistered"] {
        let m = msg(
            "daemon:33333333-3333-3333-3333-333333333333",
            "phx_reply",
            serde_json::json!({
                "status": "error",
                "response": {"reason": reason}
            }),
        );
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::DaemonJoinFailed(
                "33333333-3333-3333-3333-333333333333".to_string(),
                Some(reason.to_string())
            )
        );
        assert!(matches!(
            daemon_join_recovery(Some(reason)),
            ChannelRecovery::RetireAndStop(_)
        ));
    }
}

#[test]
fn classify_non_project_topic() {
    let projects = known_projects(&["proj-1"]);
    let m = msg("phoenix", "heartbeat", serde_json::json!({}));
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::NonProjectTopic
    );
}

#[test]
fn classify_project_topic_with_unknown_project_is_ignored() {
    let projects = known_projects(&["proj-1"]);
    let m = msg("project:unknown", "task_created", serde_json::json!({}));
    assert_eq!(
        classify_channel_message(&m, &projects),
        ChannelAction::NonProjectTopic
    );
}

#[test]
fn channel_interruptions_and_duplicate_connections_are_recoverable() {
    for event in ["phx_close", "phx_error"] {
        assert_eq!(
            classify_channel_message(
                &msg("daemon:id", event, serde_json::json!({})),
                &known_projects(&[])
            ),
            ChannelAction::DaemonChannelInterrupted
        );
    }
    for reason in [
        None,
        Some("already_connected"),
        Some("temporarily_unavailable"),
    ] {
        assert_eq!(daemon_join_recovery(reason), ChannelRecovery::Reconnect);
    }
    assert!(matches!(
        daemon_join_recovery(Some("invalid_credentials")),
        ChannelRecovery::Stop(_)
    ));
    assert!(matches!(
        daemon_join_recovery(Some("not_found")),
        ChannelRecovery::RetireAndStop(_)
    ));
    assert!(matches!(
        daemon_join_recovery(Some("identity_mismatch")),
        ChannelRecovery::Stop(_)
    ));
}

#[tokio::test]
async fn standalone_channel_interruption_reconnects_with_the_same_identity() {
    use futures::{SinkExt, StreamExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (rejoined_tx, rejoined_rx) = tokio::sync::oneshot::channel();
    let (reject_tx, reject_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut joins = Vec::new();
        for connection in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let join = loop {
                let frame = socket.next().await.unwrap().unwrap();
                let message: serde_json::Value =
                    serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if message[2] == "phoenix" && message[3] == "heartbeat" {
                    continue;
                }
                break message;
            };
            assert_eq!(join[3], "phx_join");
            assert_eq!(join[2], "daemon:33333333-3333-3333-3333-333333333333");
            joins.push(join[2].clone());
            if connection == 0 {
                socket.send(Message::Text(serde_json::json!([join[0], join[1], join[2], "phx_reply", {"status":"ok"}]).to_string().into())).await.unwrap();
                let report = loop {
                    let frame = tokio::time::timeout(Duration::from_secs(1), socket.next())
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap();
                    let message: serde_json::Value =
                        serde_json::from_str(frame.to_text().unwrap()).unwrap();
                    if message[2] == "phoenix" && message[3] == "heartbeat" {
                        continue;
                    }
                    break message;
                };
                assert_eq!(report[3], "report");
                assert_eq!(report[4]["version"], 1);
                socket.send(Message::Text(serde_json::json!([report[0], report[1], report[2], "phx_reply", {"status":"ok"}]).to_string().into())).await.unwrap();
                if let Ok(Some(Ok(extra))) =
                    tokio::time::timeout(Duration::from_millis(100), socket.next()).await
                {
                    let extra: serde_json::Value =
                        serde_json::from_str(extra.to_text().unwrap()).unwrap();
                    assert_ne!(extra[3], "report");
                }
                socket
                    .send(Message::Text(
                        serde_json::json!([join[0], null, join[2], "phx_error", {}])
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                // Keep the TCP connection open until the daemon closes it.
                let _ = socket.next().await;
            } else {
                assert_eq!(joins[0], joins[1]);
                rejoined_tx.send(()).unwrap();
                reject_rx.await.unwrap();
                socket.send(Message::Text(serde_json::json!([join[0], join[1], join[2], "phx_reply", {"status":"error", "response":{"reason":"invalid_credentials"}}]).to_string().into())).await.unwrap();
                let _ = socket.next().await;
                break;
            }
        }
    });
    let mut config = sample_daemon_config();
    config.base_url = endpoint.clone();
    config.identity = crate::config::DaemonIdentity {
        endpoint,
        daemon_id: "33333333-3333-3333-3333-333333333333".to_string(),
        reconnect_token: "test-reconnect-token".to_string(),
        expires_at: "2099-01-01T00:00:00Z".to_string(),
    };
    let (actor, mut handle) = Actor::spawn(None, DaemonSupervisor, config).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), rejoined_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(!handle.is_finished());
    reject_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), &mut handle)
        .await
        .unwrap()
        .unwrap();
    server.await.unwrap();
    drop(actor);
}

// ===== DaemonConfig tests =====

fn sample_daemon_config() -> DaemonConfig {
    let provider_binaries = crate::helpers::ProviderBinaries {
        anthropic: Some(std::path::PathBuf::from("/usr/local/bin/claude")),
        openai: Some(std::path::PathBuf::from("/usr/local/bin/codex")),
    };
    DaemonConfig {
        base_url: "http://localhost:4000".to_string(),
        identity: crate::config::DaemonIdentity {
            endpoint: "http://localhost:4000".to_string(),
            daemon_id: "33333333-3333-3333-3333-333333333333".to_string(),
            reconnect_token: "sac_super_secret_token".to_string(),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
        },
        capabilities: Arc::new(crate::capabilities::DaemonCapabilities {
            harnesses: HashMap::new(),
            provider_binaries,
            shell_path: "/usr/bin:/bin".to_string(),
            installed_skills_roots: Vec::new(),
            installed_skills_diagnostic: None,
            claude_plugin_dir: vertebrae_installer::ClaudePluginDirResolution {
                plugin_root: None,
                warning: None,
            },
            typesafe_api_key: None,
            typesafe_base_url: None,
        }),
    }
}

#[test]
fn daemon_config_debug_redacts_reconnect_token() {
    let cfg = sample_daemon_config();
    let dbg = format!("{:?}", cfg);
    assert!(
        !dbg.contains("sac_super_secret_token"),
        "reconnect token leaked in Debug: {dbg}"
    );
    assert!(
        dbg.contains("<redacted>"),
        "expected redaction marker: {dbg}"
    );
    // Other useful fields are still visible for diagnostics.
    assert!(dbg.contains("http://localhost:4000"));
    // Both resolved binaries are reflected in the debug output.
    assert!(dbg.contains("capabilities"));
}

#[test]
fn daemon_config_carries_both_provider_binaries() {
    let cfg = sample_daemon_config();
    assert!(cfg.capabilities.provider_binaries.anthropic.is_some());
    assert!(cfg.capabilities.provider_binaries.openai.is_some());
}
