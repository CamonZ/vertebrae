use std::{io::ErrorKind, process::Stdio, time::Duration};

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
const EXECUTABLE_BUSY_RETRIES: usize = 10;
const EXECUTABLE_BUSY_RETRY_DELAY: Duration = Duration::from_millis(10);

pub(super) enum ProcessOutput {
    Stdout(String),
    Stderr(String),
    StdoutClosed,
    StderrClosed,
    ReadError(String),
}

pub(super) async fn spawn_process(
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
    #[cfg(unix)]
    command.process_group(0);
    for attempt in 0..=EXECUTABLE_BUSY_RETRIES {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error)
                if error.kind() == ErrorKind::ExecutableFileBusy
                    && attempt < EXECUTABLE_BUSY_RETRIES =>
            {
                tokio::time::sleep(EXECUTABLE_BUSY_RETRY_DELAY).await;
            }
            Err(error) => {
                return Err(HarnessError::Operation(format!(
                    "failed to spawn Claude at {}: {error}",
                    spec.program.display()
                )));
            }
        }
    }
    unreachable!("the retry loop either spawned a process or returned its final error")
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
    let pid = child.id();
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(Ok(status)) => {
            terminate_process_group(pid, true);
            (Some(status), false)
        }
        Ok(Err(_)) => (None, false),
        Err(_) => {
            terminate_process_group(pid, false);
            #[cfg(not(unix))]
            let _ = child.start_kill();
            let status = tokio::time::timeout(
                grace.max(std::time::Duration::from_millis(250)),
                child.wait(),
            )
            .await
            .ok()
            .and_then(Result::ok);
            let status = if status.is_none() {
                terminate_process_group(pid, true);
                #[cfg(not(unix))]
                let _ = child.start_kill();
                tokio::time::timeout(
                    grace.max(std::time::Duration::from_millis(250)),
                    child.wait(),
                )
                .await
                .ok()
                .and_then(Result::ok)
            } else {
                terminate_process_group(pid, true);
                status
            };
            (status, true)
        }
    }
}

pub(super) async fn reap(
    child: &mut Child,
    cleanup_timeout: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    let pid = child.id();
    if let Ok(Some(status)) = child.try_wait() {
        terminate_process_group(pid, true);
        return Some(status);
    }
    terminate_process_group(pid, false);
    #[cfg(not(unix))]
    let _ = child.start_kill();
    let status = tokio::time::timeout(cleanup_timeout, child.wait())
        .await
        .ok()
        .and_then(Result::ok);
    if status.is_none() {
        terminate_process_group(pid, true);
        #[cfg(not(unix))]
        let _ = child.start_kill();
        tokio::time::timeout(cleanup_timeout, child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        terminate_process_group(pid, true);
        status
    }
}

#[cfg(unix)]
fn terminate_process_group(pid: Option<u32>, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            log::warn!(
                "[CLAUDE] failed to clean up process group pid={pid}, force={force}: {error}"
            );
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: Option<u32>, _force: bool) {}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

    use tempfile::TempDir;

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

    #[tokio::test]
    async fn spawn_retries_while_a_fixture_is_open_for_writing() {
        let temp = TempDir::new().unwrap();
        let script = temp.path().join("busy-fixture");
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
        let writer = fs::OpenOptions::new().write(true).open(&script).unwrap();

        let release_writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(writer);
        });
        let spec = ClaudeCommandSpec {
            program: script,
            args: Vec::new(),
            current_dir: None,
            environment: Default::default(),
        };
        let mut child = spawn_process(&spec, false)
            .await
            .expect("the launcher should retry a transient executable-busy error");
        release_writer.await.unwrap();
        assert!(child.wait().await.unwrap().success());
    }

    #[tokio::test]
    async fn reap_terminates_descendants_after_leader_exits() {
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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().expect("fixture process should start");

        let status = reap(&mut child, Duration::from_millis(250)).await;
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(status.is_some(), "the provider child must be reaped");
        assert!(
            !marker.exists(),
            "a Claude helper process must not outlive its provider tree"
        );
    }
}
