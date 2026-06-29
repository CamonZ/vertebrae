//! Long-lived Claude JSONL process runner.
//!
//! This runner is intentionally scoped to Claude-style harnesses that keep a
//! stdin pipe open for JSONL user messages while streaming JSONL on stdout.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus};
use std::thread;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) type ClaudeJsonlInputEncoder =
    Box<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync + 'static>;
pub(crate) type ClaudeStdoutProcessor =
    Box<dyn FnOnce(BufReader<ChildStdout>, String) + Send + 'static>;
pub(crate) type ClaudeStderrProcessor =
    Box<dyn FnOnce(BufReader<ChildStderr>, String) + Send + 'static>;

/// Commands sent to a live Claude JSONL process.
pub(crate) enum ClaudeLiveJsonlCommand {
    SendMessage {
        content: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    Close {
        response: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaudeLiveJsonlExitReason {
    CloseCommand,
    StdoutClosed,
    CommandChannelClosed,
}

#[derive(Debug)]
pub(crate) struct ClaudeLiveJsonlRunResult {
    pub(crate) exit_reason: ClaudeLiveJsonlExitReason,
    pub(crate) wait_status: Option<ExitStatus>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeLiveJsonlProcessError {
    #[error("failed to spawn live Claude JSONL process: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("live Claude JSONL process was spawned without piped stdin")]
    MissingStdin,
    #[error("live Claude JSONL process was spawned without piped stdout")]
    MissingStdout,
    #[error("live Claude JSONL process was spawned without piped stderr")]
    MissingStderr,
}

pub(crate) struct ClaudeLiveJsonlProcessRunner {
    session_id: String,
    command: Command,
    command_rx: mpsc::UnboundedReceiver<ClaudeLiveJsonlCommand>,
    initial_prompt: Option<String>,
    input_encoder: ClaudeJsonlInputEncoder,
    stdout_processor: ClaudeStdoutProcessor,
    stderr_processor: ClaudeStderrProcessor,
}

impl ClaudeLiveJsonlProcessRunner {
    pub(crate) fn new(
        session_id: String,
        command: Command,
        command_rx: mpsc::UnboundedReceiver<ClaudeLiveJsonlCommand>,
        input_encoder: ClaudeJsonlInputEncoder,
        stdout_processor: ClaudeStdoutProcessor,
        stderr_processor: ClaudeStderrProcessor,
    ) -> Self {
        Self {
            session_id,
            command,
            command_rx,
            initial_prompt: None,
            input_encoder,
            stdout_processor,
            stderr_processor,
        }
    }

    pub(crate) fn with_initial_prompt(mut self, initial_prompt: Option<String>) -> Self {
        self.initial_prompt = initial_prompt;
        self
    }

    pub(crate) fn run(mut self) -> Result<ClaudeLiveJsonlRunResult, ClaudeLiveJsonlProcessError> {
        let mut child = self
            .command
            .spawn()
            .map_err(ClaudeLiveJsonlProcessError::Spawn)?;
        log::info!("Claude live JSONL process spawned successfully");

        let Some(mut stdin) = child.stdin.take() else {
            cleanup_child(&mut child);
            return Err(ClaudeLiveJsonlProcessError::MissingStdin);
        };
        let Some(stdout) = child.stdout.take() else {
            cleanup_child(&mut child);
            return Err(ClaudeLiveJsonlProcessError::MissingStdout);
        };
        let Some(stderr) = child.stderr.take() else {
            cleanup_child(&mut child);
            return Err(ClaudeLiveJsonlProcessError::MissingStderr);
        };

        if let Some(prompt) = self.initial_prompt.as_deref() {
            if let Err(err) =
                write_user_message(&mut stdin, &self.session_id, prompt, &self.input_encoder)
            {
                log::warn!(
                    "Failed to write initial Claude JSONL prompt for session {}: {}",
                    self.session_id,
                    err
                );
            }
        }

        let (stdout_exit_tx, stdout_exit_rx) = std::sync::mpsc::channel();
        let stdout_session_id = self.session_id.clone();
        let stdout_processor = self.stdout_processor;
        thread::spawn(move || {
            stdout_processor(BufReader::new(stdout), stdout_session_id);
            let _ = stdout_exit_tx.send(());
        });

        let stderr_session_id = self.session_id.clone();
        let stderr_processor = self.stderr_processor;
        thread::spawn(move || {
            stderr_processor(BufReader::new(stderr), stderr_session_id);
        });

        let exit_reason = loop {
            match self.command_rx.try_recv() {
                Ok(ClaudeLiveJsonlCommand::SendMessage { content, response }) => {
                    let result = write_user_message(
                        &mut stdin,
                        &self.session_id,
                        &content,
                        &self.input_encoder,
                    );
                    let _ = response.send(result);
                }
                Ok(ClaudeLiveJsonlCommand::Close { response }) => {
                    let _ = response.send(Ok(()));
                    break ClaudeLiveJsonlExitReason::CloseCommand;
                }
                Err(mpsc::error::TryRecvError::Empty) => {
                    if stdout_exit_rx.try_recv().is_ok() {
                        break ClaudeLiveJsonlExitReason::StdoutClosed;
                    }
                    thread::sleep(COMMAND_POLL_INTERVAL);
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    break ClaudeLiveJsonlExitReason::CommandChannelClosed;
                }
            }
        };

        drop(stdin);
        let wait_status = cleanup_child(&mut child);

        Ok(ClaudeLiveJsonlRunResult {
            exit_reason,
            wait_status,
        })
    }
}

fn cleanup_child(child: &mut Child) -> Option<ExitStatus> {
    let _ = child.kill();
    child.wait().ok()
}

fn write_user_message(
    stdin: &mut impl Write,
    session_id: &str,
    content: &str,
    input_encoder: &ClaudeJsonlInputEncoder,
) -> Result<(), String> {
    let json = input_encoder(session_id, content)?;
    writeln!(stdin, "{}", json).map_err(|err| err.to_string())?;
    stdin.flush().map_err(|err| err.to_string())
}

pub(crate) fn encode_claude_user_jsonl_message(
    session_id: &str,
    content: &str,
) -> Result<String, String> {
    let input_msg = serde_json::json!({
        "type": "user",
        "session_id": session_id,
        "parent_tool_use_id": null,
        "message": {
            "role": "user",
            "content": content
        }
    });
    serde_json::to_string(&input_msg).map_err(|err| err.to_string())
}

/// Process stderr lines from the Claude CLI.
/// Passes each non-empty line, prefixed with `[stderr]`, to the callback.
/// Stops on read error.
pub(crate) fn process_claude_stderr_lines(
    reader: impl BufRead,
    session_id: &str,
    mut on_error: impl FnMut(String),
) {
    for line in reader.lines() {
        match line {
            Ok(line) if !line.is_empty() => {
                log::warn!(
                    "[Claude stderr] session={} {}",
                    &session_id[..8.min(session_id.len())],
                    &line[..500.min(line.len())]
                );
                on_error(format!("[stderr] {}", line));
            }
            Err(e) => {
                log::error!("Error reading stderr: {}", e);
                break;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_chat::harnesses::claude::jsonl::{self, EmittedEvent};
    use serde_json::Value;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc as std_mpsc;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn write_script(dir: &TempDir, name: &str, body: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, body).expect("script should be written");
        let mut permissions = fs::metadata(&path)
            .expect("script metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("script should be executable");
        path
    }

    fn command_for_script(script: &Path) -> Command {
        let mut command = Command::new(script);
        command.stdin(std::process::Stdio::piped());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command
    }

    fn runner_for_command(
        session_id: &str,
        command: Command,
        command_rx: mpsc::UnboundedReceiver<ClaudeLiveJsonlCommand>,
    ) -> ClaudeLiveJsonlProcessRunner {
        ClaudeLiveJsonlProcessRunner::new(
            session_id.to_string(),
            command,
            command_rx,
            Box::new(encode_claude_user_jsonl_message),
            Box::new(|reader, session_id| {
                jsonl::process_jsonl_lines(reader, &session_id, |_| {});
            }),
            Box::new(|reader, session_id| {
                process_claude_stderr_lines(reader, &session_id, |_| {});
            }),
        )
    }

    fn spawn_runner(
        runner: ClaudeLiveJsonlProcessRunner,
    ) -> std_mpsc::Receiver<Result<ClaudeLiveJsonlRunResult, ClaudeLiveJsonlProcessError>> {
        let (done_tx, done_rx) = std_mpsc::channel();
        thread::spawn(move || {
            let _ = done_tx.send(runner.run());
        });
        done_rx
    }

    fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if predicate() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("condition was not met within {:?}", timeout);
    }

    fn read_lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(ToString::to_string)
            .collect()
    }

    async fn send_message(
        command_tx: &mpsc::UnboundedSender<ClaudeLiveJsonlCommand>,
        content: &str,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(ClaudeLiveJsonlCommand::SendMessage {
                content: content.to_string(),
                response: response_tx,
            })
            .expect("runner should accept SendMessage");
        tokio::time::timeout(Duration::from_secs(2), response_rx)
            .await
            .expect("SendMessage response should not time out")
            .expect("SendMessage response should not be dropped")
    }

    async fn close_runner(
        command_tx: &mpsc::UnboundedSender<ClaudeLiveJsonlCommand>,
    ) -> Result<(), String> {
        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(ClaudeLiveJsonlCommand::Close {
                response: response_tx,
            })
            .expect("runner should accept Close");
        tokio::time::timeout(Duration::from_secs(2), response_rx)
            .await
            .expect("Close response should not time out")
            .expect("Close response should not be dropped")
    }

    #[tokio::test]
    async fn send_message_writes_one_claude_jsonl_line() {
        let temp = TempDir::new().expect("temp dir should be created");
        let capture = temp.path().join("stdin.jsonl");
        let script = write_script(
            &temp,
            "capture-stdin.sh",
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CAPTURE"
done
"#,
        );
        let mut command = command_for_script(&script);
        command.env("CAPTURE", &capture);
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = runner_for_command("session-1", command, command_rx);
        let done_rx = spawn_runner(runner);

        send_message(&command_tx, "hello\nworld")
            .await
            .expect("SendMessage should write successfully");
        wait_until(Duration::from_secs(2), || read_lines(&capture).len() == 1);
        close_runner(&command_tx)
            .await
            .expect("Close should acknowledge");

        let result = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish")
            .expect("runner should not error");
        assert_eq!(result.exit_reason, ClaudeLiveJsonlExitReason::CloseCommand);
        assert!(result.wait_status.is_some());

        let lines = read_lines(&capture);
        assert_eq!(lines.len(), 1);
        let line: Value = serde_json::from_str(&lines[0]).expect("line should be JSON");
        assert_eq!(line["type"], "user");
        assert_eq!(line["session_id"], "session-1");
        assert_eq!(line["parent_tool_use_id"], Value::Null);
        assert_eq!(line["message"]["role"], "user");
        assert_eq!(line["message"]["content"], "hello\nworld");
    }

    #[tokio::test]
    async fn initial_prompt_is_written_before_later_commands() {
        let temp = TempDir::new().expect("temp dir should be created");
        let capture = temp.path().join("stdin.jsonl");
        let script = write_script(
            &temp,
            "capture-stdin.sh",
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CAPTURE"
done
"#,
        );
        let mut command = command_for_script(&script);
        command.env("CAPTURE", &capture);
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = runner_for_command("session-2", command, command_rx)
            .with_initial_prompt(Some("start here".to_string()));
        let done_rx = spawn_runner(runner);

        wait_until(Duration::from_secs(2), || read_lines(&capture).len() == 1);
        send_message(&command_tx, "follow up")
            .await
            .expect("SendMessage should write successfully");
        wait_until(Duration::from_secs(2), || read_lines(&capture).len() == 2);
        close_runner(&command_tx)
            .await
            .expect("Close should acknowledge");
        let _ = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish")
            .expect("runner should not error");

        let lines = read_lines(&capture);
        let first: Value = serde_json::from_str(&lines[0]).expect("initial prompt should be JSON");
        let second: Value = serde_json::from_str(&lines[1]).expect("message should be JSON");
        assert_eq!(first["message"]["content"], "start here");
        assert_eq!(second["message"]["content"], "follow up");
    }

    #[tokio::test]
    async fn stdout_events_are_forwarded_through_claude_parser() {
        let temp = TempDir::new().expect("temp dir should be created");
        let script = write_script(
            &temp,
            "emit-stdout.sh",
            r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"parsed text"}]}}'
while IFS= read -r _; do
  :
done
"#,
        );
        let (event_tx, event_rx) = std_mpsc::channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = ClaudeLiveJsonlProcessRunner::new(
            "session-3".to_string(),
            command_for_script(&script),
            command_rx,
            Box::new(encode_claude_user_jsonl_message),
            Box::new(move |reader, session_id| {
                jsonl::process_jsonl_lines(reader, &session_id, |events| {
                    for event in events {
                        let _ = event_tx.send(event);
                    }
                });
            }),
            Box::new(|reader, session_id| {
                process_claude_stderr_lines(reader, &session_id, |_| {});
            }),
        );
        let done_rx = spawn_runner(runner);

        let event = event_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("stdout parser should emit an event");
        match event {
            EmittedEvent::Text(event) => {
                assert_eq!(event.session_id, "session-3");
                assert_eq!(event.text, "parsed text");
                assert!(!event.is_partial);
            }
            other => panic!("expected text event, got {:?}", other),
        }

        close_runner(&command_tx)
            .await
            .expect("Close should acknowledge");
        let _ = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish")
            .expect("runner should not error");
    }

    #[tokio::test]
    async fn stderr_lines_are_forwarded_to_error_callback() {
        let temp = TempDir::new().expect("temp dir should be created");
        let script = write_script(
            &temp,
            "emit-stderr.sh",
            r#"#!/bin/sh
printf '%s\n' 'warning from claude' >&2
while IFS= read -r _; do
  :
done
"#,
        );
        let (error_tx, error_rx) = std_mpsc::channel();
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = ClaudeLiveJsonlProcessRunner::new(
            "session-4".to_string(),
            command_for_script(&script),
            command_rx,
            Box::new(encode_claude_user_jsonl_message),
            Box::new(|reader, session_id| {
                jsonl::process_jsonl_lines(reader, &session_id, |_| {});
            }),
            Box::new(move |reader, session_id| {
                process_claude_stderr_lines(reader, &session_id, |message| {
                    let _ = error_tx.send(message);
                });
            }),
        );
        let done_rx = spawn_runner(runner);

        assert_eq!(
            error_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("stderr callback should receive a line"),
            "[stderr] warning from claude"
        );

        close_runner(&command_tx)
            .await
            .expect("Close should acknowledge");
        let _ = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish")
            .expect("runner should not error");
    }

    #[tokio::test]
    async fn close_command_terminates_child_cleanup() {
        let temp = TempDir::new().expect("temp dir should be created");
        let ready = temp.path().join("ready");
        let script = write_script(
            &temp,
            "wait-forever.sh",
            r#"#!/bin/sh
printf ready > "$READY"
while true; do
  sleep 1
done
"#,
        );
        let mut command = command_for_script(&script);
        command.env("READY", &ready);
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = runner_for_command("session-5", command, command_rx);
        let done_rx = spawn_runner(runner);

        wait_until(Duration::from_secs(2), || ready.exists());
        close_runner(&command_tx)
            .await
            .expect("Close should acknowledge");
        let result = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish after Close")
            .expect("runner should not error");

        assert_eq!(result.exit_reason, ClaudeLiveJsonlExitReason::CloseCommand);
        let status = result.wait_status.expect("child should be waited");
        assert!(
            !status.success(),
            "long-lived mock should be terminated by cleanup"
        );
    }

    #[test]
    fn stdout_reader_exit_terminates_runner() {
        let temp = TempDir::new().expect("temp dir should be created");
        let script = write_script(
            &temp,
            "exit-after-stdout.sh",
            r#"#!/bin/sh
printf '%s\n' '{"type":"result","duration_ms":1,"num_turns":1,"total_cost_usd":0.0,"result":"done","is_error":false}'
"#,
        );
        let (_command_tx, command_rx) = mpsc::unbounded_channel();
        let runner = runner_for_command("session-6", command_for_script(&script), command_rx);
        let done_rx = spawn_runner(runner);

        let result = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("runner should finish when stdout closes")
            .expect("runner should not error");
        assert_eq!(result.exit_reason, ClaudeLiveJsonlExitReason::StdoutClosed);
        assert!(result
            .wait_status
            .expect("child should be waited")
            .success());
    }
}
