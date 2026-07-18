use std::process::Stdio;

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
};
use vertebrae_harness_core::HarnessError;

use crate::ClaudeCommandSpec;

/// Bounds in-memory provider output while the runtime is busy handling an
/// event sink or a control response. Reader tasks naturally apply backpressure
/// to the child process once this queue is full.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;

pub(super) enum ProcessOutput {
    Stdout(String),
    Stderr(String),
    StdoutClosed,
    StderrClosed,
    ReadError(String),
}

pub(super) fn spawn_process(
    spec: &ClaudeCommandSpec,
    piped_stdin: bool,
) -> Result<Child, HarnessError> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    if let Some(directory) = &spec.current_dir {
        command.current_dir(directory);
    }
    command.envs(&spec.environment);
    command
        .stdin(if piped_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().map_err(|error| {
        HarnessError::Operation(format!(
            "failed to spawn Claude at {}: {error}",
            spec.program.display()
        ))
    })
}

pub(super) fn spawn_output_readers(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) -> mpsc::Receiver<ProcessOutput> {
    let (sender, receiver) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let stdout_sender = sender.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if stdout_sender
                        .send(ProcessOutput::Stdout(line))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = stdout_sender.send(ProcessOutput::StdoutClosed).await;
                    return;
                }
                Err(error) => {
                    let _ = stdout_sender
                        .send(ProcessOutput::ReadError(format!("stdout: {error}")))
                        .await;
                    return;
                }
            }
        }
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if sender.send(ProcessOutput::Stderr(line)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(ProcessOutput::StderrClosed).await;
                    return;
                }
                Err(error) => {
                    let _ = sender
                        .send(ProcessOutput::ReadError(format!("stderr: {error}")))
                        .await;
                    return;
                }
            }
        }
    });
    receiver
}

pub(super) async fn wait_then_reap(
    child: &mut Child,
    grace: std::time::Duration,
) -> (Option<std::process::ExitStatus>, bool) {
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            let _ = child.start_kill();
            let status = tokio::time::timeout(
                grace.max(std::time::Duration::from_millis(250)),
                child.wait(),
            )
            .await
            .ok()
            .and_then(Result::ok);
            (status, true)
        }
    }
}

pub(super) async fn reap(
    child: &mut Child,
    cleanup_timeout: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    let _ = child.start_kill();
    tokio::time::timeout(cleanup_timeout, child.wait())
        .await
        .ok()
        .and_then(Result::ok)
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn output_readers_apply_backpressure_at_capacity() {
        let mut child = Command::new("sh")
            .args([
                "-c",
                "i=0; while [ $i -lt 300 ]; do printf '%s\\n' line; i=$((i + 1)); done",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let output = spawn_output_readers(stdout, stderr);

        tokio::time::timeout(Duration::from_secs(1), async {
            while output.len() < OUTPUT_CHANNEL_CAPACITY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reader should fill its bounded queue");
        assert_eq!(output.len(), OUTPUT_CHANNEL_CAPACITY);

        drop(output);
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }
}
