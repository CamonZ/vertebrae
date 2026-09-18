use std::time::{Duration, Instant};

use cucumber::{then, when};
use vertebrae_sacrum_client::{DaemonStatus, DaemonSummary, SacrumDaemonService};

use crate::DaemonWorld;

#[when("I enroll and start a standalone daemon")]
pub async fn enroll_and_start_standalone_daemon(world: &mut DaemonWorld) {
    world.stop_daemon().await;
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let name = format!("daemon-telemetry-{}", uuid::Uuid::new_v4());
    let bootstrap = SacrumDaemonService::new((*client).clone())
        .create_daemon(Some(&name))
        .await
        .expect("create standalone daemon enrollment");
    let daemon_id = bootstrap.daemon.id.clone();
    world.daemon_id = Some(daemon_id.clone());
    world.created_daemon_ids.push(daemon_id.clone());
    world
        .start_standalone_daemon(&daemon_id, &bootstrap.enrollment_token)
        .await;
}

async fn wait_for_telemetry(world: &DaemonWorld) -> DaemonSummary {
    let daemon_id = world.daemon_id.as_ref().expect("daemon was not enrolled");
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let service = SacrumDaemonService::new((*client).clone());
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_observation = String::from("no snapshot");

    loop {
        if let Ok(Some(daemon)) = service.get_daemon(daemon_id).await {
            last_observation = format!("{daemon:?}");
            if daemon.report_version == Some(1)
                && daemon.daemon_version.is_some()
                && daemon.started_at.is_some()
                && daemon.last_seen_at.is_some()
            {
                return daemon;
            }
        }
        if Instant::now() >= deadline {
            panic!("standalone daemon telemetry was not published within 15s: {last_observation}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[then("the daemon fleet snapshot contains startup telemetry")]
pub async fn fleet_snapshot_contains_startup_telemetry(world: &mut DaemonWorld) {
    let daemon = wait_for_telemetry(world).await;
    assert_eq!(daemon.status, DaemonStatus::Active);
    assert_eq!(daemon.connection_status.as_deref(), Some("online"));
    assert_eq!(daemon.health.as_deref(), Some("healthy"));
    assert_eq!(daemon.report_version, Some(1));
    assert_eq!(daemon.daemon_version.as_deref(), Some("0.1.0"));
    assert_eq!(daemon.os.as_deref(), Some("linux"));

    let capabilities = daemon
        .capabilities
        .as_ref()
        .expect("daemon telemetry did not include capabilities");
    assert_eq!(capabilities["providers"]["anthropic"], true);
    assert_eq!(capabilities["providers"]["openai"], true);
    assert_eq!(capabilities["harnesses"]["claude_code"], true);
    assert_eq!(capabilities["harnesses"]["codex"], true);
}

#[then("the daemon fleet snapshot contains no credential or executable path")]
pub async fn fleet_snapshot_contains_no_sensitive_runtime_data(world: &mut DaemonWorld) {
    let daemon = wait_for_telemetry(world).await;
    let snapshot = serde_json::to_string(&daemon).expect("serialize daemon snapshot");
    for value in [
        "token",
        "reconnect",
        "CLAUDE_CODE_PATH",
        "CODEX_PATH",
        "/usr/local/bin",
    ] {
        assert!(
            !snapshot.contains(value),
            "snapshot leaked {value}: {snapshot}"
        );
    }
}
