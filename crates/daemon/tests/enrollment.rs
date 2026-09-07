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
