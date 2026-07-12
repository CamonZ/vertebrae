use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, ToSocketAddrs};
use tokio::process::{Child, Command};
use tokio::time::{sleep, Instant};

use crate::helpers::find_codex_binary;
use crate::local_chat::{LocalChatHarnessInfo, LocalChatHarnessKind};

use super::models::{
    codex_model_options, codex_reasoning_effort_options, parse_codex_model_catalog,
    CodexModelCatalog, CODEX_DEFAULT_MODEL_ID, CODEX_DEFAULT_REASONING_EFFORT,
};

const APP_SERVER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const APP_SERVER_READY_POLL: Duration = Duration::from_millis(50);
const APP_SERVER_LAUNCH_ATTEMPTS: usize = 3;

static CODEX_MODEL_CATALOG: OnceLock<Result<CodexModelCatalog, String>> = OnceLock::new();

#[async_trait]
pub(super) trait CodexAppServerLauncher: Send + Sync {
    fn info(&self) -> LocalChatHarnessInfo;

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String>;
}

pub(super) struct LaunchedCodexAppServer {
    pub(super) ws_url: String,
    pub(super) process: Option<Child>,
}

pub(super) struct ProcessCodexAppServerLauncher;

#[async_trait]
impl CodexAppServerLauncher for ProcessCodexAppServerLauncher {
    fn info(&self) -> LocalChatHarnessInfo {
        let (available, unavailable_reason, catalog) = match find_codex_binary() {
            Ok(binary) => (true, None, codex_model_catalog(&binary).ok()),
            Err(error) => (false, Some(error), None),
        };
        LocalChatHarnessInfo {
            harness: LocalChatHarnessKind::Codex,
            label: "Codex".to_string(),
            available,
            unavailable_reason,
            default_model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
            models: codex_model_options(catalog),
            default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
            reasoning_efforts: codex_reasoning_effort_options(catalog),
            supports_resume: true,
        }
    }

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String> {
        let binary = find_codex_binary()?;
        let mut last_error = None;

        for _ in 0..APP_SERVER_LAUNCH_ATTEMPTS {
            let (ws_url, ready_addr) = reserve_local_ws_url()?;
            let mut process = spawn_codex_app_server(&binary, &ws_url)?;
            match wait_for_ready(ready_addr).await {
                Ok(()) => {
                    return Ok(LaunchedCodexAppServer {
                        ws_url,
                        process: Some(process),
                    });
                }
                Err(err) => {
                    let _ = process.kill().await;
                    let _ = process.wait().await;
                    last_error = Some(err);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            "Failed to start Codex app-server after all launch attempts".to_string()
        }))
    }
}

fn codex_model_catalog(binary: &PathBuf) -> Result<&'static CodexModelCatalog, String> {
    CODEX_MODEL_CATALOG
        .get_or_init(|| load_codex_model_catalog(binary))
        .as_ref()
        .map_err(Clone::clone)
}

fn load_codex_model_catalog(binary: &PathBuf) -> Result<CodexModelCatalog, String> {
    load_catalog_output(|| {
        let output = ProcessCommand::new(binary)
            .args(["debug", "models", "--bundled"])
            .output()
            .map_err(|error| format!("Failed to run Codex model catalog: {error}"))?;
        if !output.status.success() {
            return Err(format!("Codex model catalog exited with {}", output.status));
        }
        String::from_utf8(output.stdout)
            .map_err(|error| format!("Codex model catalog was not UTF-8: {error}"))
    })
}

pub(super) fn load_catalog_output(
    command: impl FnOnce() -> Result<String, String>,
) -> Result<CodexModelCatalog, String> {
    let output = command()?;
    parse_codex_model_catalog(&output)
}

fn reserve_local_ws_url() -> Result<(String, SocketAddr), String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to reserve local app-server port: {err}"))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read local app-server port: {err}"))?;
    drop(listener);
    Ok((format!("ws://{addr}"), addr))
}

fn spawn_codex_app_server(binary: &PathBuf, ws_url: &str) -> Result<Child, String> {
    Command::new(binary)
        .arg("app-server")
        .arg("--listen")
        .arg(ws_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Failed to spawn {}: {err}", binary.display()))
}

async fn wait_for_ready(addr: impl ToSocketAddrs + Copy) -> Result<(), String> {
    let deadline = Instant::now() + APP_SERVER_READY_TIMEOUT;
    while Instant::now() < deadline {
        if ready_probe(addr).await.unwrap_or(false) {
            return Ok(());
        }
        sleep(APP_SERVER_READY_POLL).await;
    }
    Err("Timed out waiting for Codex app-server /readyz".to_string())
}

pub(super) async fn ready_probe(addr: impl ToSocketAddrs) -> Result<bool, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|err| format!("Codex app-server is not accepting connections yet: {err}"))?;
    stream
        .write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .map_err(|err| format!("Failed to write Codex app-server readiness probe: {err}"))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 64];
    loop {
        let bytes = stream
            .read(&mut chunk)
            .await
            .map_err(|err| format!("Failed to read Codex app-server readiness probe: {err}"))?;
        if bytes == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..bytes]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") || response.len() >= 1024 {
            break;
        }
    }

    Ok(std::str::from_utf8(&response).is_ok_and(|response| {
        response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
    }))
}
