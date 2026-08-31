use std::{net::SocketAddr, process::Stdio, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, ToSocketAddrs},
    process::{Child, Command},
    time::{Instant, sleep},
};
use vertebrae_harness_core::HarnessError;

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
    let Some(child) = process.as_mut() else {
        return;
    };
    let pid = child.id();
    if let Ok(Ok(_)) = tokio::time::timeout(timeout, child.wait()).await {
        terminate_process_group(pid, "normal exit", true);
        *process = None;
        return;
    }
    terminate_process_group(pid, "graceful cleanup", false);
    #[cfg(not(unix))]
    let _ = child.start_kill();
    if tokio::time::timeout(timeout, child.wait()).await.is_err() {
        terminate_process_group(pid, "forced cleanup", true);
        #[cfg(not(unix))]
        let _ = child.start_kill();
        let _ = tokio::time::timeout(timeout, child.wait()).await;
    } else {
        terminate_process_group(pid, "forced cleanup after leader exit", true);
    }
    log::debug!("[CODEX] cleaned up App Server process tree pid={pid:?}");
    *process = None;
}

#[cfg(unix)]
fn terminate_process_group(pid: Option<u32>, phase: &str, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            log::warn!("[CODEX] failed {phase} process-group cleanup for pid={pid}: {error}");
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: Option<u32>, _phase: &str, _force: bool) {}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::process::Command;

    use super::*;

    #[tokio::test]
    async fn cleanup_process_terminates_descendants_after_leader_exits() {
        let temp = TempDir::new().expect("temporary directory should be available");
        let marker = temp.path().join("descendant-survived");
        let script = format!(
            "trap '' TERM; (sleep 1; touch '{}') & exit 0",
            marker.display()
        );
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let child = command.spawn().expect("fixture process should start");
        let mut process = Some(child);

        cleanup_process(&mut process, Duration::from_millis(250)).await;
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(process.is_none(), "cleanup should release the child handle");
        assert!(
            !marker.exists(),
            "a descendant must not outlive the App Server process tree"
        );
    }
}
