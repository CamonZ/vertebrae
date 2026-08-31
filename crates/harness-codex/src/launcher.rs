use std::{net::SocketAddr, process::Stdio, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, ToSocketAddrs},
    process::{Child, Command},
    time::{Instant, sleep},
};
use vertebrae_harness_core::{HarnessError, ReapMode, reap_optional_process};

use crate::CodexProviderConfig;

pub struct LaunchedCodexAppServer {
    pub ws_url: String,
    pub process: Option<Child>,
}

#[async_trait]
pub trait CodexAppServerLauncher: Send + Sync {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError>;
}

pub struct ProcessCodexAppServerLauncher {
    config: Arc<CodexProviderConfig>,
}

impl ProcessCodexAppServerLauncher {
    pub fn new(config: Arc<CodexProviderConfig>) -> Self {
        Self { config }
    }
}

#[async_trait]
impl CodexAppServerLauncher for ProcessCodexAppServerLauncher {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError> {
        let binary = self.config.resolve_executable()?;
        let attempts = self.config.launch_attempts.max(1);
        let mut last_error = None;
        for _ in 0..attempts {
            let (ws_url, ready_addr) = reserve_local_ws_url()?;
            let mut command = Command::new(&binary);
            command
                .arg("app-server")
                .arg("--listen")
                .arg(&ws_url)
                .args(&self.config.extra_args)
                .envs(self.config.environment.clone())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(unix)]
            command.process_group(0);
            if let Some(path) = &self.config.search_path {
                command.env("PATH", path.to_string_lossy().into_owned());
            }
            let process = command.spawn().map_err(|error| {
                HarnessError::Operation(format!("failed to spawn {}: {error}", binary.display()))
            })?;
            match wait_for_ready(ready_addr, self.config.readiness_timeout).await {
                Ok(()) => {
                    return Ok(LaunchedCodexAppServer {
                        ws_url,
                        process: Some(process),
                    });
                }
                Err(error) => {
                    let mut process = Some(process);
                    cleanup_process(&mut process, self.config.cleanup_timeout).await;
                    last_error = Some(error);
                }
            }
        }
        Err(last_error
            .unwrap_or_else(|| HarnessError::Operation("failed to start Codex App Server".into())))
    }
}

fn reserve_local_ws_url() -> Result<(String, SocketAddr), HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| {
        HarnessError::Operation(format!("failed to reserve Codex App Server port: {error}"))
    })?;
    let address = listener.local_addr().map_err(|error| {
        HarnessError::Operation(format!("failed to read Codex App Server port: {error}"))
    })?;
    drop(listener);
    Ok((format!("ws://{address}"), address))
}

async fn wait_for_ready(
    address: impl ToSocketAddrs + Copy,
    timeout: Duration,
) -> Result<(), HarnessError> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ready_probe(address).await.unwrap_or(false) {
            return Ok(());
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err(HarnessError::Operation(
        "timed out waiting for Codex App Server /readyz".into(),
    ))
}

pub async fn ready_probe(address: impl ToSocketAddrs) -> Result<bool, HarnessError> {
    let mut stream = TcpStream::connect(address).await.map_err(|error| {
        HarnessError::Operation(format!(
            "Codex App Server is not accepting connections yet: {error}"
        ))
    })?;
    stream
        .write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .map_err(|error| {
            HarnessError::Operation(format!("failed to write Codex readiness probe: {error}"))
        })?;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 128];
    loop {
        let count = stream.read(&mut chunk).await.map_err(|error| {
            HarnessError::Operation(format!("failed to read Codex readiness probe: {error}"))
        })?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..count]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") || response.len() >= 1024 {
            break;
        }
    }
    Ok(std::str::from_utf8(&response)
        .is_ok_and(|value| value.starts_with("HTTP/1.1 200") || value.starts_with("HTTP/1.0 200")))
}

pub(crate) async fn cleanup_process(process: &mut Option<Child>, timeout: Duration) {
    let _ = reap_optional_process(process, timeout, ReapMode::WaitThenSignal).await;
}
