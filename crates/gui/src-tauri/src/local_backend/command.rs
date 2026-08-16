use std::ffi::OsString;
use std::fmt;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::state::LocalBackendError;

const DEFAULT_CAPTURE_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub(crate) struct CommandRequest {
    pub(super) action: String,
    pub(super) program: OsString,
    pub(super) args: Vec<OsString>,
    pub(super) env: Vec<(OsString, OsString)>,
    pub(super) timeout: Duration,
    pub(super) max_capture_bytes: usize,
}

impl CommandRequest {
    pub fn new(
        action: impl Into<String>,
        program: impl Into<OsString>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        timeout: Duration,
    ) -> Self {
        Self {
            action: action.into(),
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            timeout,
            max_capture_bytes: DEFAULT_CAPTURE_BYTES,
        }
    }

    pub fn with_env(
        mut self,
        env: impl IntoIterator<Item = (impl Into<OsString>, impl Into<OsString>)>,
    ) -> Self {
        self.env = env
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect();
        self
    }

    pub fn with_capture_limit(mut self, max_capture_bytes: usize) -> Self {
        self.max_capture_bytes = max_capture_bytes;
        self
    }

    #[cfg(test)]
    pub fn args_as_strings(&self) -> Vec<String> {
        self.args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(test)]
    pub fn env_value(&self, name: &str) -> Option<&std::ffi::OsStr> {
        self.env
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_os_str())
    }
}

impl fmt::Debug for CommandRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandRequest")
            .field("action", &self.action)
            .field("program", &self.program)
            .field("args", &self.args)
            .field(
                "env",
                &self
                    .env
                    .iter()
                    .map(|(name, _)| (name, "[redacted]"))
                    .collect::<Vec<_>>(),
            )
            .field("timeout", &self.timeout)
            .field("max_capture_bytes", &self.max_capture_bytes)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandOutput {
    pub(super) success: bool,
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) truncated: bool,
}

impl CommandOutput {
    #[cfg(test)]
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            success: true,
            exit_code: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
            truncated: false,
        }
    }

    #[cfg(test)]
    pub fn failure(exit_code: i32, stderr: impl Into<String>) -> Self {
        Self {
            success: false,
            exit_code: Some(exit_code),
            stdout: String::new(),
            stderr: stderr.into(),
            truncated: false,
        }
    }

    pub fn summary(&self) -> String {
        let stdout = self.stdout.trim();
        let stderr = self.stderr.trim();
        let mut summary = match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (false, true) => stdout.to_string(),
            (true, false) => stderr.to_string(),
            (true, true) => "no command output".to_string(),
        };
        if self.truncated {
            summary.push_str("\n[output truncated]");
        }
        summary
    }
}

#[async_trait]
pub(crate) trait ProcessRunner: Send + Sync {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SystemProcessRunner;

#[async_trait]
impl ProcessRunner for SystemProcessRunner {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .envs(request.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| LocalBackendError::CommandFailed {
                action: request.action.clone(),
                status: "could not start".to_string(),
                output: format!("{}: {error}", request.program.to_string_lossy()),
            })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdout_task = tokio::spawn(read_bounded(stdout, request.max_capture_bytes));
        let stderr_task = tokio::spawn(read_bounded(stderr, request.max_capture_bytes));

        let status = match tokio::time::timeout(request.timeout, child.wait()).await {
            Ok(result) => result.map_err(|error| LocalBackendError::CommandFailed {
                action: request.action.clone(),
                status: "could not wait for completion".to_string(),
                output: error.to_string(),
            })?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(LocalBackendError::CommandTimedOut {
                    action: request.action,
                    timeout_seconds: request.timeout.as_secs(),
                    output: "command terminated after reaching its time limit".to_string(),
                });
            }
        };
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();
        Ok(CommandOutput {
            success: status.success(),
            exit_code: status.code(),
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
        })
    }
}

#[derive(Default)]
struct BoundedRead {
    text: String,
    truncated: bool,
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> BoundedRead {
    let mut captured = Vec::with_capacity(limit);
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = limit.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        truncated |= count > remaining;
    }
    BoundedRead {
        text: String::from_utf8_lossy(&captured).into_owned(),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_runner_bounds_captured_output() {
        let request = CommandRequest::new(
            "emit output",
            "/bin/sh",
            [
                "-c",
                "i=0; while [ \"$i\" -lt 20000 ]; do printf x; i=$((i + 1)); done",
            ],
            Duration::from_secs(2),
        );

        let output = SystemProcessRunner.run(request).await.expect("run command");

        assert!(output.success);
        assert_eq!(output.stdout.len(), DEFAULT_CAPTURE_BYTES);
        assert!(output.truncated);
        assert!(output.summary().ends_with("[output truncated]"));
    }

    #[tokio::test]
    async fn system_runner_kills_timed_out_commands() {
        let request = CommandRequest::new(
            "slow command",
            "/bin/sh",
            ["-c", "printf started; while :; do :; done"],
            Duration::from_millis(20),
        );

        let error = SystemProcessRunner
            .run(request)
            .await
            .expect_err("command should time out");

        assert!(matches!(
            error,
            LocalBackendError::CommandTimedOut { action, output, .. }
                if action == "slow command" && output.contains("terminated")
        ));
    }
}
