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
fn classify_run_step_routes_unknown_harness_to_project_for_execution_failure() {
    let projects = known_projects(&["proj-1"]);
    let m = msg(
        "daemon:33333333-3333-3333-3333-333333333333",
        "run_step",
        serde_json::json!({
            "project_id": "proj-1",
            "id": "execution-1",
            "task_id": "task-1",
            "harness": "openai"
        }),
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
            ChannelRecovery::Reenroll(ReenrollmentReason::IdentityRetired)
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
    assert_eq!(
        daemon_join_recovery(Some("invalid_credentials")),
        ChannelRecovery::Reenroll(ReenrollmentReason::CredentialRejected)
    );
    assert!(matches!(
        daemon_join_recovery(Some("not_found")),
        ChannelRecovery::Reenroll(ReenrollmentReason::IdentityRetired)
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
        mistral_vibe: None,
    };
    DaemonConfig::new(
        "http://localhost:4000".to_string(),
        crate::config::DaemonIdentity {
            endpoint: "http://localhost:4000".to_string(),
            daemon_id: "33333333-3333-3333-3333-333333333333".to_string(),
            reconnect_token: "sac_super_secret_token".to_string(),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
        },
        Arc::new(crate::capabilities::DaemonCapabilities {
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
            typesafe_api_key_secret: None,
            typesafe_base_url: None,
            typesafe_url: None,
            provider_config_path: None,
            provider_profiles: Default::default(),
        }),
    )
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

// ===== Credential renewal =====

struct ScriptedRenewer {
    renewals: std::sync::atomic::AtomicUsize,
    reject: bool,
    release: tokio::sync::Notify,
    persisted: std::sync::Mutex<Vec<crate::config::DaemonIdentity>>,
}

impl ScriptedRenewer {
    fn new(reject: bool) -> Arc<Self> {
        Arc::new(Self {
            renewals: std::sync::atomic::AtomicUsize::new(0),
            reject,
            release: tokio::sync::Notify::new(),
            persisted: std::sync::Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl CredentialRenewer for ScriptedRenewer {
    async fn renew(
        &self,
        current: &crate::config::DaemonIdentity,
    ) -> Result<crate::renewal::RenewedCredential, crate::renewal::RenewalError> {
        assert_eq!(current.reconnect_token, "expiring-secret");
        self.renewals
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Hold the request open so overlapping triggers can be observed.
        self.release.notified().await;
        if self.reject {
            return Err(crate::renewal::RenewalError::InvalidCredentials);
        }
        Ok(crate::renewal::RenewedCredential {
            reconnect_token: "renewed-secret".to_string(),
            expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
        })
    }

    fn persist(
        &self,
        _previous: &crate::config::DaemonIdentity,
        renewed: &crate::config::DaemonIdentity,
    ) -> Result<(), crate::config::ConfigError> {
        self.persisted.lock().unwrap().push(renewed.clone());
        Ok(())
    }
}

/// A Phoenix peer that confirms every daemon join and reports each
/// connection's reconnect credential.
#[expect(
    clippy::result_large_err,
    reason = "tungstenite fixes the handshake callback's error type"
)]
fn spawn_phoenix_peer(
    listener: tokio::net::TcpListener,
) -> tokio::sync::mpsc::UnboundedReceiver<String> {
    use futures::{SinkExt, StreamExt};
    let (tokens_tx, tokens_rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let tokens_tx = tokens_tx.clone();
            tokio::spawn(async move {
                let mut token = String::new();
                let callback =
                    |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     response| {
                        token = url::Url::parse(&format!("http://peer{}", request.uri()))
                            .unwrap()
                            .query_pairs()
                            .find(|(key, _)| key == "reconnect_token")
                            .map(|(_, value)| value.into_owned())
                            .unwrap_or_default();
                        Ok(response)
                    };
                let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await
                else {
                    return;
                };
                let _ = tokens_tx.send(token);
                while let Some(Ok(frame)) = socket.next().await {
                    let Ok(text) = frame.to_text() else { continue };
                    let Ok(message) = serde_json::from_str::<serde_json::Value>(text) else {
                        continue;
                    };
                    if message[2] == "phoenix" {
                        continue;
                    }
                    let reply = serde_json::json!([message[0], message[1], message[2], "phx_reply", {"status": "ok"}]);
                    if socket
                        .send(Message::Text(reply.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
    });
    tokens_rx
}

async fn renewal_config(
    renewer: Arc<ScriptedRenewer>,
) -> (DaemonConfig, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let tokens = spawn_phoenix_peer(listener);
    let mut config = sample_daemon_config();
    config.base_url = endpoint.clone();
    config.identity = crate::config::DaemonIdentity {
        endpoint,
        daemon_id: "33333333-3333-3333-3333-333333333333".to_string(),
        reconnect_token: "expiring-secret".to_string(),
        // Inside the default 24h lead window.
        expires_at: (Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
    };
    config.renewer = renewer;
    (config, tokens)
}

async fn next_token(tokens: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(5), tokens.recv())
        .await
        .expect("connection within 5s")
        .expect("peer running")
}

#[tokio::test]
async fn due_credential_renews_once_persists_and_reconnects_with_the_successor() {
    let renewer = ScriptedRenewer::new(false);
    let (config, mut tokens) = renewal_config(renewer.clone()).await;
    let (actor, handle) = Actor::spawn(None, DaemonSupervisor, config).await.unwrap();
    assert_eq!(next_token(&mut tokens).await, "expiring-secret");

    // Join confirmation already started the renewal; extra triggers coalesce.
    for _ in 0..3 {
        actor.cast(DaemonMessage::CheckCredential).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while renewer.renewals.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    renewer.release.notify_one();

    assert_eq!(next_token(&mut tokens).await, "renewed-secret");
    assert_eq!(
        renewer.renewals.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let persisted = renewer.persisted.lock().unwrap().clone();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].reconnect_token, "renewed-secret");

    // The renewed credential is outside the lead window: no further renewal.
    actor.cast(DaemonMessage::CheckCredential).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        renewer.renewals.load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    actor.cast(DaemonMessage::Shutdown).unwrap();
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn rejected_renewal_stops_for_reenrollment_without_reconnecting() {
    let renewer = ScriptedRenewer::new(true);
    let (config, mut tokens) = renewal_config(renewer.clone()).await;
    let signal = config.reenrollment.clone();
    let (_actor, handle) = Actor::spawn(None, DaemonSupervisor, config).await.unwrap();
    assert_eq!(next_token(&mut tokens).await, "expiring-secret");
    tokio::time::timeout(Duration::from_secs(5), async {
        while renewer.renewals.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    renewer.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(signal.get(), Some(ReenrollmentReason::CredentialRejected));
    assert!(tokens.try_recv().is_err(), "no reconnect after rejection");
}

#[tokio::test]
async fn expired_credential_fails_startup_without_connecting() {
    let renewer = ScriptedRenewer::new(false);
    let (mut config, mut tokens) = renewal_config(renewer.clone()).await;
    config.identity.expires_at = (Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
    let signal = config.reenrollment.clone();
    assert!(Actor::spawn(None, DaemonSupervisor, config).await.is_err());
    assert_eq!(signal.get(), Some(ReenrollmentReason::Expired));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(tokens.try_recv().is_err(), "no socket connect attempt");
    assert_eq!(
        renewer.renewals.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn startup_with_rejected_socket_auth_requires_reenrollment() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let mut config = sample_daemon_config();
    config.base_url = endpoint.clone();
    config.identity.endpoint = endpoint;
    let signal = config.reenrollment.clone();
    assert!(Actor::spawn(None, DaemonSupervisor, config).await.is_err());
    assert_eq!(signal.get(), Some(ReenrollmentReason::CredentialRejected));
    server.await.unwrap();
}

#[tokio::test]
async fn startup_while_offline_keeps_retrying_with_a_valid_credential() {
    // Reserve a port, then close it so connections are refused.
    let endpoint = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let mut config = sample_daemon_config();
    config.base_url = endpoint.clone();
    config.identity.endpoint = endpoint;
    let signal = config.reenrollment.clone();
    let spawn = tokio::time::timeout(
        Duration::from_millis(500),
        Actor::spawn(None, DaemonSupervisor, config),
    )
    .await;
    assert!(spawn.is_err(), "startup is still retrying");
    assert_eq!(signal.get(), None);
}

#[test]
fn daemon_config_defaults_always_enable_renewal_with_a_one_day_lead() {
    let config = sample_daemon_config();
    assert_eq!(config.renewal, RenewalPolicy::default());
    assert_eq!(config.renewal.lead, Duration::from_secs(24 * 60 * 60));
    assert!(config.renewal.check_interval <= Duration::from_secs(5 * 60));
    assert_eq!(config.reenrollment.get(), None);
}

#[test]
fn enrolled_daemon_toml_without_renewal_settings_is_renewed_automatically() {
    // Exactly the format `vtb-daemon enroll` writes: no renewal keys exist.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("daemon.toml");
    let expires_at = (Utc::now() + chrono::Duration::hours(3)).to_rfc3339();
    std::fs::write(
        &path,
        format!(
            "endpoint = \"https://sacrum.example.test\"\ndaemon_id = \"33333333-3333-3333-3333-333333333333\"\nreconnect_token = \"enrolled-secret\"\nexpires_at = \"{expires_at}\"\n"
        ),
    )
    .unwrap();
    let identity = crate::config::load_daemon_identity_for_test(&path);
    let config = DaemonConfig::new(
        identity.endpoint.clone(),
        identity,
        Arc::new(crate::capabilities::DaemonCapabilities::clone(
            &sample_daemon_config().capabilities,
        )),
    );
    assert_eq!(
        credential_status(&config.identity.expires_at, Utc::now(), config.renewal.lead),
        CredentialStatus::RenewalDue
    );
}
