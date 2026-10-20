#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

const FIRST_ID: &str = "33333333-3333-3333-3333-333333333333";
const SECOND_ID: &str = "44444444-4444-4444-4444-444444444444";

fn config_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/vertebrae")
    } else {
        home.join("config/vertebrae")
    }
}

async fn enroll(home: &Path, endpoint: &str, id: &str) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vtb-daemon"))
        .args([
            "enroll",
            "--endpoint",
            endpoint,
            "--daemon-id",
            id,
            "--token-stdin",
        ])
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"test-bootstrap-token\n")
        .await
        .unwrap();
    child
}

#[tokio::test]
async fn competing_process_does_not_exchange_or_overwrite_identity() {
    let home = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/daemon/exchange"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({
                    "daemon_id": FIRST_ID,
                    "reconnect_token": "test-reconnect-token",
                    "expires_at": "2099-01-01T00:00:00Z",
                }))
                .set_delay(Duration::from_secs(1)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let first = enroll(home.path(), &server.uri(), FIRST_ID).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.received_requests().await.unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // The first process holds its storage lock while the remote exchange waits.
    let second = enroll(home.path(), &server.uri(), SECOND_ID).await;
    let second = second.wait_with_output().await.unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("cannot lock enrollment"));
    let first = first.wait_with_output().await.unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let saved = std::fs::read_to_string(config_dir(home.path()).join("daemon.toml")).unwrap();
    assert!(saved.contains(FIRST_ID));
    assert!(!saved.contains(SECOND_ID));
    assert!(!saved.contains("test-bootstrap-token"));
    assert!(!String::from_utf8_lossy(&first.stdout).contains("test-reconnect-token"));
    server.verify().await;
}

#[tokio::test]
async fn corrupt_config_is_reported_without_secret_contents() {
    let home = tempfile::tempdir().unwrap();
    let directory = config_dir(home.path());
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("daemon.toml"),
        "reconnect_token = \"PRIVATE-CREDENTIAL\" trailing\n",
    )
    .unwrap();
    let output = enroll(home.path(), "http://127.0.0.1:1", FIRST_ID)
        .await
        .wait_with_output()
        .await
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("failed to parse daemon config"));
    assert!(!stderr.contains("PRIVATE-CREDENTIAL"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE-CREDENTIAL"));
}

#[tokio::test]
async fn retired_identity_blocks_account_token_fallback() {
    let home = tempfile::tempdir().unwrap();
    let directory = config_dir(home.path());
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("config.toml"),
        "[sacrum]\nurl = \"https://sacrum.example.com\"\ntoken = \"account-token\"\n",
    )
    .unwrap();
    std::fs::write(
        directory.join("daemon.toml"),
        format!(
            "endpoint = \"https://sacrum.example.com\"\ndaemon_id = \"{FIRST_ID}\"\nretired = true\n"
        ),
    )
    .unwrap();
    std::fs::write(directory.join("daemon.lock"), "").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_vtb-daemon"))
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("Connecting to Phoenix WebSocket"));
    assert!(
        std::fs::read_to_string(directory.join("config.toml"))
            .unwrap()
            .contains("account-token")
    );
    assert!(directory.join("daemon.lock").exists());
}

fn write_identity(directory: &Path, endpoint: &str, token: &str, expires_at: &str) {
    std::fs::write(
        directory.join("daemon.toml"),
        format!(
            "endpoint = \"{endpoint}\"\ndaemon_id = \"{FIRST_ID}\"\nreconnect_token = \"{token}\"\nexpires_at = \"{expires_at}\"\n"
        ),
    )
    .unwrap();
}

async fn wait_for_log(log: &Path, needle: &str) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let text = std::fs::read_to_string(log).unwrap_or_default();
            if text.contains(needle) {
                return text;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "daemon did not log {needle:?}: {}",
            std::fs::read_to_string(log).unwrap_or_default()
        )
    })
}

#[tokio::test]
async fn expired_credential_waits_for_reenrollment_instead_of_exiting() {
    let home = tempfile::tempdir().unwrap();
    let directory = config_dir(home.path());
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("config.toml"),
        "[sacrum]\nurl = \"http://127.0.0.1:1\"\n",
    )
    .unwrap();
    // Port 1 refuses connections, so any connection attempt is visible in the log.
    write_identity(
        &directory,
        "http://127.0.0.1:1",
        "EXPIRED-CREDENTIAL",
        "2020-01-01T00:00:00Z",
    );
    let log_path = home.path().join("daemon.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_vtb-daemon"))
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .env("RUST_LOG", "info")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let text = wait_for_log(&log_path, "Daemon re-enrollment required").await;
    assert!(text.contains(FIRST_ID));
    assert!(text.contains("--replace-existing"));
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(daemon.try_wait().unwrap().is_none(), "daemon keeps running");
    let text = std::fs::read_to_string(&log_path).unwrap();
    assert_eq!(text.matches("Daemon re-enrollment required").count(), 1);
    assert!(!text.contains("Connecting to Phoenix WebSocket"));

    // `vtb-daemon enroll --replace-existing` writes a fresh credential.
    write_identity(
        &directory,
        "http://127.0.0.1:1",
        "FRESH-CREDENTIAL",
        "2099-01-01T00:00:00Z",
    );
    wait_for_log(&log_path, "Connecting to Phoenix WebSocket").await;
    let text = std::fs::read_to_string(&log_path).unwrap();
    assert!(text.contains("Daemon re-enrolled"));
    assert!(!text.contains("EXPIRED-CREDENTIAL"));
    assert!(!text.contains("FRESH-CREDENTIAL"));

    let pid = daemon.id().unwrap().to_string();
    let status = std::process::Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = tokio::time::timeout(Duration::from_secs(10), daemon.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        exit.success(),
        "shutdown during startup retries exits cleanly"
    );
}
