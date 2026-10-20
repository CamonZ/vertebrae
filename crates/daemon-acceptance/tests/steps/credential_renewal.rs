//! Automatic reconnect-credential renewal and re-enrollment recovery.
//!
//! Every scenario runs `vtb-daemon` with its default configuration: renewal
//! is driven only by the persisted `expires_at`, never by test settings.
use std::process::Stdio;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use cucumber::{given, then, when};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, SacrumDaemonService};

use crate::DaemonWorld;

const REGISTERED: &str = "Standalone daemon identity registered";
const RENEWING: &str = "Renewing daemon reconnect credential before expiry";
const RENEWED: &str = "Daemon reconnect credential renewed";
const REENROLLMENT_REQUIRED: &str = "Daemon re-enrollment required";
const REENROLLED: &str = "Daemon re-enrolled";
const CONNECTING: &str = "Connecting to Phoenix WebSocket";

#[derive(Debug, Default)]
pub struct RenewalObservations {
    /// The reconnect credential written by enrollment.
    pub enrolled_token: Option<String>,
    /// The credential the daemon persisted after renewing.
    pub renewed_token: Option<String>,
    /// A bootstrap credential issued by owner rotation.
    pub rotated_bootstrap: Option<String>,
    /// Every credential that must never appear in daemon output.
    pub secrets: Vec<String>,
    /// Daemon log length when re-enrollment started.
    pub reenrollment_log_offset: usize,
}

struct PersistedCredential {
    reconnect_token: String,
    expires_at: DateTime<Utc>,
}

fn read_credential(world: &DaemonWorld) -> PersistedCredential {
    let path = world.daemon_toml_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{key} = ")))
            .map(|value| value.trim().trim_matches('"').to_string())
            .unwrap_or_else(|| panic!("daemon.toml has no {key}"))
    };
    PersistedCredential {
        reconnect_token: value("reconnect_token"),
        expires_at: DateTime::parse_from_rfc3339(&value("expires_at"))
            .expect("daemon.toml expiry is RFC 3339")
            .with_timezone(&Utc),
    }
}

/// Rewrite only `expires_at`, leaving the enrolled credential untouched.
fn rewrite_expiry(world: &DaemonWorld, expires_at: DateTime<Utc>) {
    let path = world.daemon_toml_path();
    let text = std::fs::read_to_string(&path).expect("read daemon.toml");
    let rewritten: Vec<String> = text
        .lines()
        .map(|line| {
            if line.starts_with("expires_at = ") {
                format!("expires_at = \"{}\"", expires_at.to_rfc3339())
            } else {
                line.to_string()
            }
        })
        .collect();
    std::fs::write(&path, rewritten.join("\n") + "\n").expect("rewrite daemon.toml");
}

fn project_mapping(world: &DaemonWorld) -> Vec<(String, String)> {
    vec![(
        world.project_id.clone().expect("project configured"),
        "/app".to_string(),
    )]
}

fn registration_logs(world: &DaemonWorld) -> Vec<String> {
    let projects = project_mapping(world);
    let borrowed: Vec<(&str, &str)> = projects
        .iter()
        .map(|(id, path)| (id.as_str(), path.as_str()))
        .collect();
    DaemonWorld::registration_logs(&borrowed)
}

async fn wait_for_log(world: &DaemonWorld, needle: &str, count: usize) -> String {
    wait_for_log_after(world, 0, needle, count).await
}

/// Wait for `needle` in the daemon log written after byte `offset`.
async fn wait_for_log_after(
    world: &DaemonWorld,
    offset: usize,
    needle: &str,
    count: usize,
) -> String {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let log = world
            .daemon_log()
            .get(offset..)
            .unwrap_or_default()
            .to_string();
        if log.matches(needle).count() >= count {
            return log;
        }
        if Instant::now() >= deadline {
            panic!("daemon did not log {needle:?} {count} time(s) within 60s. log:\n{log}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn daemon_id(world: &DaemonWorld) -> String {
    world.daemon_id.clone().expect("daemon was enrolled")
}

#[given("an enrolled standalone daemon that is not running")]
pub async fn enrolled_daemon_not_running(world: &mut DaemonWorld) {
    let (daemon_id, bootstrap, project_id) =
        crate::steps::setup::create_project_and_daemon(world).await;
    world
        .enroll_standalone_daemon(&daemon_id, &bootstrap, &[(&project_id, "/app")])
        .await;
    let enrolled = read_credential(world).reconnect_token;
    world.renewal.secrets.extend([bootstrap, enrolled.clone()]);
    world.renewal.enrolled_token = Some(enrolled);
}

#[given(expr = "the persisted daemon credential expires in {int} hours")]
pub async fn credential_expires_in(world: &mut DaemonWorld, hours: i64) {
    rewrite_expiry(world, Utc::now() + chrono::Duration::hours(hours));
}

#[given(expr = "the persisted daemon credential expired {int} hours ago")]
pub async fn credential_expired_ago(world: &mut DaemonWorld, hours: i64) {
    rewrite_expiry(world, Utc::now() - chrono::Duration::hours(hours));
}

#[when("I start the enrolled daemon")]
pub async fn start_enrolled_daemon(world: &mut DaemonWorld) {
    let expected = registration_logs(world);
    world.launch_enrolled_daemon(&expected).await;
}

#[when("I start the enrolled daemon without waiting for registration")]
pub async fn start_enrolled_daemon_unchecked(world: &mut DaemonWorld) {
    world.launch_enrolled_daemon(&[]).await;
}

#[when("I restart the daemon")]
pub async fn restart_daemon(world: &mut DaemonWorld) {
    world.stop_daemon_process().await;
    world.wait_for_daemon_offline(&daemon_id(world)).await;
    start_enrolled_daemon(world).await;
}

#[when("the owner rotates the daemon credentials")]
pub async fn owner_rotates_credentials(world: &mut DaemonWorld) {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql client configured")
        .clone();
    let bootstrap = SacrumDaemonService::new((*client).clone())
        .rotate_credentials(&daemon_id(world))
        .await
        .expect("rotate daemon credentials");
    world
        .renewal
        .secrets
        .push(bootstrap.enrollment_token.clone());
    world.renewal.rotated_bootstrap = Some(bootstrap.enrollment_token);
}

#[when("I re-enroll the daemon with the rotated bootstrap credential")]
pub async fn reenroll_with_rotated_bootstrap(world: &mut DaemonWorld) {
    let bootstrap = world
        .renewal
        .rotated_bootstrap
        .clone()
        .expect("owner rotated credentials");
    let home = world
        .standalone_home
        .clone()
        .expect("standalone daemon home");
    world.renewal.reenrollment_log_offset = world.daemon_log().len();
    let mut enroll = Command::new(&world.vtb_daemon_binary)
        .args([
            "enroll",
            "--endpoint",
            &world.sacrum_url,
            "--daemon-id",
            &daemon_id(world),
            "--token-stdin",
            "--replace-existing",
        ])
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn re-enrollment");
    enroll
        .stdin
        .take()
        .expect("re-enrollment stdin")
        .write_all(bootstrap.as_bytes())
        .await
        .expect("write rotated bootstrap");
    let output = enroll
        .wait_with_output()
        .await
        .expect("wait for re-enrollment");
    assert!(
        output.status.success(),
        "re-enrollment failed: stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reenrolled = read_credential(world).reconnect_token;
    world.renewal.secrets.push(reenrolled);
}

#[then("the daemon renews its reconnect credential")]
pub async fn daemon_renews(world: &mut DaemonWorld) {
    wait_for_log(world, RENEWED, 1).await;
    // Renewal reconnects the socket with the successor and registers again.
    wait_for_log(world, REGISTERED, 2).await;
    let persisted = read_credential(world);
    let enrolled = world.renewal.enrolled_token.clone().expect("enrolled");
    assert_ne!(
        persisted.reconnect_token, enrolled,
        "daemon.toml holds a different reconnect credential"
    );
    let lifetime = persisted.expires_at - Utc::now();
    assert!(
        lifetime > chrono::Duration::days(29) && lifetime <= chrono::Duration::days(30),
        "renewed credential expires about 30 days out, got {lifetime}"
    );
    world
        .renewal
        .secrets
        .push(persisted.reconnect_token.clone());
    world.renewal.renewed_token = Some(persisted.reconnect_token);
}

#[then("the daemon is online")]
pub async fn daemon_is_online(world: &mut DaemonWorld) {
    world.wait_for_daemon_online(&daemon_id(world)).await;
}

#[then("the enrolled reconnect credential is rejected")]
pub async fn enrolled_credential_rejected(world: &mut DaemonWorld) {
    let enrolled = world.renewal.enrolled_token.clone().expect("enrolled");
    let client = GraphqlClient::new_with_daemon_id(
        SacrumConfig::new(world.sacrum_url.clone(), enrolled, String::new()),
        Some(&daemon_id(world)),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let result: Result<serde_json::Value, _> = client
            .execute(
                "query Daemons { daemons { id } }",
                serde_json::json!({}),
                "daemons",
            )
            .await;
        match result {
            Err(vertebrae_sacrum_client::SacrumClientError::ApiError { status: 401, .. }) => return,
            other if Instant::now() >= deadline => {
                panic!("enrolled credential is still accepted after renewal: {other:?}")
            }
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

#[then("the daemon reconnects with the renewed credential without renewing again")]
pub async fn reconnects_without_renewing(world: &mut DaemonWorld) {
    world.wait_for_daemon_online(&daemon_id(world)).await;
    let log = world.daemon_log();
    assert!(!log.contains(RENEWING), "restart renewed again:\n{log}");
    assert_eq!(
        Some(read_credential(world).reconnect_token),
        world.renewal.renewed_token,
        "daemon.toml still holds the renewed credential"
    );
}

#[then("the daemon reports that re-enrollment is required")]
pub async fn reports_reenrollment_required(world: &mut DaemonWorld) {
    let log = wait_for_log(world, REENROLLMENT_REQUIRED, 1).await;
    assert!(log.contains(&daemon_id(world)), "message names the daemon");
    assert!(
        log.contains("--replace-existing"),
        "message includes recovery"
    );
}

#[then("the daemon makes no socket connection attempts")]
pub async fn no_socket_attempts(world: &mut DaemonWorld) {
    let log = world.daemon_log();
    assert!(
        !log.contains(CONNECTING),
        "daemon attempted to connect:\n{log}"
    );
}

#[then("the daemon keeps running without restarting")]
pub async fn keeps_running(world: &mut DaemonWorld) {
    tokio::time::sleep(Duration::from_secs(5)).await;
    let child = world.daemon.as_mut().expect("daemon was started");
    assert!(
        child.try_wait().expect("poll daemon").is_none(),
        "daemon exited instead of waiting for re-enrollment"
    );
    let log = world.daemon_log();
    assert_eq!(
        log.matches(REENROLLMENT_REQUIRED).count(),
        1,
        "re-enrollment is reported once:\n{log}"
    );
}

#[then("the daemon resumes with the re-enrolled credential")]
pub async fn resumes_after_reenrollment(world: &mut DaemonWorld) {
    let offset = world.renewal.reenrollment_log_offset;
    wait_for_log_after(world, offset, REENROLLED, 1).await;
    wait_for_log_after(world, offset, REGISTERED, 1).await;
    world.wait_for_daemon_online(&daemon_id(world)).await;
}

#[then("the daemon output contains no credential plaintext")]
pub async fn output_has_no_credentials(world: &mut DaemonWorld) {
    let log = world.daemon_log();
    for secret in world
        .renewal
        .secrets
        .iter()
        .filter(|secret| !secret.is_empty())
    {
        assert!(
            !log.contains(secret.as_str()),
            "daemon output contains a credential"
        );
    }
}
