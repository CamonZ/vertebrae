use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    task::JoinHandle,
};
use vertebrae_harness_core::HarnessError;

use crate::CodexProviderConfig;

/// Where a Codex App Server accepts WebSocket JSON-RPC connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexAppServerEndpoint {
    WebSocketUrl(String),
    /// The managed daemon's control socket, which speaks WebSocket over a
    /// Unix domain socket.
    UnixSocket(PathBuf),
}

pub struct LaunchedCodexAppServer {
    pub endpoint: CodexAppServerEndpoint,
}

#[async_trait]
pub trait CodexAppServerLauncher: Send + Sync {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError>;
}

/// Attaches to Codex's machine-wide managed App Server daemon
/// (`codex app-server daemon`). The daemon is shared with the user's own
/// Codex sessions: it is started when absent and never stopped, restarted,
/// or updated here. Its environment is the inherited process environment
/// plus `CODEX_HOME` and `PATH`; request environment and provider secrets
/// travel per thread instead.
pub struct ManagedCodexAppServerLauncher {
    config: Arc<CodexProviderConfig>,
}

impl ManagedCodexAppServerLauncher {
    pub fn new(config: Arc<CodexProviderConfig>) -> Self {
        Self { config }
    }

    async fn daemon_command(&self, subcommand: &str) -> Result<DaemonStatus, HarnessError> {
        let binary = self.config.resolve_executable()?;
        let mut command = Command::new(&binary);
        command
            .args(["app-server", "daemon", subcommand])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(codex_home) = self.config.environment.get(CODEX_HOME_ENV) {
            command.env(CODEX_HOME_ENV, codex_home);
        }
        if let Some(path) = &self.config.search_path {
            command.env("PATH", path);
        }
        let mut child = command.spawn().map_err(|error| {
            HarnessError::Unavailable(format!(
                "failed to run {} app-server daemon {subcommand}: {error}",
                binary.display()
            ))
        })?;
        let stdout = capture(child.stdout.take());
        let stderr = capture(child.stderr.take());
        let status = tokio::time::timeout(self.config.daemon_command_timeout, child.wait())
            .await
            .map_err(|_| {
                HarnessError::Unavailable(format!(
                    "timed out running `codex app-server daemon {subcommand}`"
                ))
            })?
            .map_err(|error| {
                HarnessError::Unavailable(format!(
                    "failed to wait for `codex app-server daemon {subcommand}`: {error}"
                ))
            })?;
        // `start` leaves a detached daemon that may inherit these pipes, so
        // they need not reach EOF: collect what was written by exit.
        let stdout = stdout.finish().await;
        let parsed = parse_daemon_status(&stdout);
        if !status.success() && parsed.is_none() {
            return Err(HarnessError::Unavailable(format!(
                "`codex app-server daemon {subcommand}` failed ({status}): {}",
                stderr.finish().await.trim()
            )));
        }
        parsed.ok_or_else(|| {
            HarnessError::Unavailable(format!(
                "`codex app-server daemon {subcommand}` printed no status JSON: {}",
                stdout.trim()
            ))
        })
    }
}

#[async_trait]
impl CodexAppServerLauncher for ManagedCodexAppServerLauncher {
    async fn launch(&self) -> Result<LaunchedCodexAppServer, HarnessError> {
        // With no daemon (for example on first use) `version` exits nonzero
        // with a plain-text error instead of status JSON, so any `version`
        // failure falls through to `start`, which reports its own errors.
        let status = match self.daemon_command("version").await {
            Ok(status) if status.is_running() => status,
            outcome => {
                let state = outcome.map_or_else(|error| error.to_string(), |status| status.status);
                log::info!(
                    "[Codex] managed App Server daemon is not running ({state}); starting it"
                );
                self.daemon_command("start").await?
            }
        };
        let socket_path = status.socket_path.filter(|_| status.status != "notRunning");
        let Some(socket_path) = socket_path else {
            return Err(HarnessError::Unavailable(format!(
                "Codex App Server daemon did not report a control socket (status {})",
                status.status
            )));
        };
        Ok(LaunchedCodexAppServer {
            endpoint: CodexAppServerEndpoint::UnixSocket(socket_path),
        })
    }
}

const CODEX_HOME_ENV: &str = "CODEX_HOME";

const CAPTURE_LIMIT: usize = 64 * 1024;

/// Output of a child pipe, accumulated without requiring EOF. The reader is
/// aborted when this is dropped, so a detached daemon that inherited the pipe
/// cannot keep it alive.
struct CapturedPipe {
    buffer: Arc<Mutex<Vec<u8>>>,
    reader: Option<JoinHandle<()>>,
}

fn capture(pipe: Option<impl AsyncRead + Unpin + Send + 'static>) -> CapturedPipe {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let reader = pipe.map(|mut pipe| {
        let buffer = Arc::clone(&buffer);
        tokio::spawn(async move {
            let mut chunk = [0_u8; 4096];
            while let Ok(count) = pipe.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                let mut buffer = buffer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let room = CAPTURE_LIMIT.saturating_sub(buffer.len());
                buffer.extend_from_slice(&chunk[..count.min(room)]);
            }
        })
    });
    CapturedPipe { buffer, reader }
}

impl CapturedPipe {
    async fn finish(mut self) -> String {
        if let Some(reader) = self.reader.as_mut() {
            let _ = tokio::time::timeout(Duration::from_millis(250), reader).await;
        }
        let buffer = self
            .buffer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        String::from_utf8_lossy(&buffer).into_owned()
    }
}

impl Drop for CapturedPipe {
    fn drop(&mut self) {
        if let Some(reader) = &self.reader {
            reader.abort();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    status: String,
    #[serde(default)]
    socket_path: Option<PathBuf>,
}

impl DaemonStatus {
    fn is_running(&self) -> bool {
        matches!(
            self.status.as_str(),
            "running" | "alreadyRunning" | "started"
        ) && self.socket_path.is_some()
    }
}

/// The daemon subcommands print one JSON status object; tolerate log lines
/// around it.
fn parse_daemon_status(stdout: &str) -> Option<DaemonStatus> {
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line.trim()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_daemon_status() {
        let status = parse_daemon_status(
            r#"{"status":"running","backend":"pid","socketPath":"/home/u/.codex/app-server-control/app-server-control.sock","cliVersion":"0.162.0"}"#,
        )
        .expect("status");
        assert!(status.is_running());
        assert_eq!(
            status.socket_path,
            Some(PathBuf::from(
                "/home/u/.codex/app-server-control/app-server-control.sock"
            ))
        );
    }

    #[test]
    fn treats_already_running_start_as_running_and_not_running_as_absent() {
        let started = parse_daemon_status(
            "starting\n{\"status\":\"alreadyRunning\",\"socketPath\":\"/tmp/s.sock\"}\n",
        )
        .expect("status");
        assert!(started.is_running());
        let absent = parse_daemon_status(r#"{"status":"notRunning"}"#).expect("status");
        assert!(!absent.is_running());
        assert!(parse_daemon_status("not json").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_the_daemon_when_version_fails_without_status_json() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("codex");
        std::fs::write(
            &executable,
            "#!/bin/sh\nif [ \"$3\" = version ]; then echo 'Error: failed to connect' >&2; exit 1; fi\necho '{\"status\":\"started\",\"socketPath\":\"/tmp/s.sock\"}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let launcher = ManagedCodexAppServerLauncher::new(Arc::new(CodexProviderConfig {
            executable: Some(executable),
            ..Default::default()
        }));

        let launched = launcher.launch().await.unwrap();

        assert_eq!(
            launched.endpoint,
            CodexAppServerEndpoint::UnixSocket(PathBuf::from("/tmp/s.sock"))
        );
    }

    #[tokio::test]
    async fn capture_is_bounded_and_reader_stops_when_dropped() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let captured = capture(Some(reader));
        let buffer = Arc::clone(&captured.buffer);
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let chunk = [b'x'; 4096];
            for _ in 0..40 {
                if writer.write_all(&chunk).await.is_err() {
                    break;
                }
            }
            std::future::pending::<()>().await;
        });
        let text = captured.finish().await;
        assert_eq!(text.len(), CAPTURE_LIMIT);
        assert_eq!(buffer.lock().unwrap().len(), CAPTURE_LIMIT);
    }

    #[cfg(unix)]
    fn fake_codex(directory: &std::path::Path, version_status: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("codex");
        let log = directory.join("calls.log");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\necho \"$3 CODEX_HOME=$CODEX_HOME\" >> {log}\nif [ \"$3\" = version ]; then echo '{{\"status\":\"{version_status}\",\"socketPath\":\"/tmp/v.sock\"}}'; else echo '{{\"status\":\"started\",\"socketPath\":\"/tmp/s.sock\"}}'; fi\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        executable
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_an_absent_daemon_and_attaches_a_running_one_without_restarting_it() {
        for (version_status, calls, socket) in [
            (
                "notRunning",
                "version CODEX_HOME=/tmp/codex-home\nstart CODEX_HOME=/tmp/codex-home\n",
                "/tmp/s.sock",
            ),
            (
                "running",
                "version CODEX_HOME=/tmp/codex-home\n",
                "/tmp/v.sock",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let launcher = ManagedCodexAppServerLauncher::new(Arc::new(CodexProviderConfig {
                executable: Some(fake_codex(directory.path(), version_status)),
                environment: [(CODEX_HOME_ENV.to_string(), "/tmp/codex-home".to_string())].into(),
                ..Default::default()
            }));

            let launched = launcher.launch().await.unwrap();

            assert_eq!(
                launched.endpoint,
                CodexAppServerEndpoint::UnixSocket(PathBuf::from(socket))
            );
            assert_eq!(
                std::fs::read_to_string(directory.path().join("calls.log")).unwrap(),
                calls
            );
        }
    }
}
