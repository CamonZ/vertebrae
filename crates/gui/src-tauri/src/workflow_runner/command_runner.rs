//! Abstraction over process spawning for workflow execution
//!
//! Provides a `CommandRunner` trait so orchestrator, executor, and retry logic
//! can be tested without spawning real Claude CLI processes.

use std::path::Path;

/// Output from running a command
#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub stdout: String,
    pub success: bool,
    pub exit_code: Option<i32>,
}

/// Trait for running external commands
///
/// Production code uses `TokioCommandRunner` which spawns real processes.
/// Tests use `MockCommandRunner` which returns canned responses.
#[async_trait::async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, program: &Path, args: &[String]) -> Result<ProcessOutput, String>;
}

/// Production command runner using `tokio::process::Command`
///
/// Spawns a real process, streams stdout line-by-line (optionally writing to
/// a workflow log file), collects all output, and returns a `ProcessOutput`.
pub struct TokioCommandRunner {
    /// If set, each stdout line is appended to the workflow log with (task_id, phase).
    pub log_context: Option<(String, String)>,
}

impl TokioCommandRunner {
    pub fn with_log_context(task_id: impl Into<String>, phase: impl Into<String>) -> Self {
        Self {
            log_context: Some((task_id.into(), phase.into())),
        }
    }
}

#[async_trait::async_trait]
impl CommandRunner for TokioCommandRunner {
    async fn run(&self, program: &Path, args: &[String]) -> Result<ProcessOutput, String> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::process::Command;

        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn process: {}", e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout".to_string())?;

        let mut reader = BufReader::new(stdout);
        let mut output = String::new();
        let mut line = String::new();

        loop {
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    output.push_str(&line);
                    if let Some((ref task_id, ref phase)) = self.log_context {
                        let _ = super::logging::append_to_workflow_log(task_id, phase, line.trim());
                    }
                    line.clear();
                }
                Err(e) => return Err(format!("Failed to read line: {}", e)),
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Failed to wait: {}", e))?;

        Ok(ProcessOutput {
            stdout: output,
            success: status.success(),
            exit_code: status.code(),
        })
    }
}

/// Mock command runner for testing
///
/// Returns canned responses from a queue. Each call to `run()` pops
/// the next response. Returns an error if the queue is empty.
#[cfg(test)]
pub struct MockCommandRunner {
    pub responses:
        std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Result<ProcessOutput, String>>>>,
}

#[cfg(test)]
impl MockCommandRunner {
    pub fn new(responses: Vec<Result<ProcessOutput, String>>) -> Self {
        Self {
            responses: std::sync::Arc::new(std::sync::Mutex::new(responses.into())),
        }
    }
}

#[cfg(test)]
#[async_trait::async_trait]
impl CommandRunner for MockCommandRunner {
    async fn run(&self, _program: &Path, _args: &[String]) -> Result<ProcessOutput, String> {
        let mut queue = self.responses.lock().unwrap();
        queue
            .pop_front()
            .unwrap_or_else(|| Err("MockCommandRunner: no more responses in queue".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_returns_enqueued_responses_in_order() {
        let runner = MockCommandRunner::new(vec![
            Ok(ProcessOutput {
                stdout: "first".to_string(),
                success: true,
                exit_code: Some(0),
            }),
            Ok(ProcessOutput {
                stdout: "second".to_string(),
                success: false,
                exit_code: Some(1),
            }),
        ]);

        let path = std::path::PathBuf::from("/fake");
        let r1 = runner.run(&path, &[]).await.unwrap();
        assert_eq!(r1.stdout, "first");
        assert!(r1.success);

        let r2 = runner.run(&path, &[]).await.unwrap();
        assert_eq!(r2.stdout, "second");
        assert!(!r2.success);
    }

    #[tokio::test]
    async fn mock_returns_error_when_queue_empty() {
        let runner = MockCommandRunner::new(vec![]);
        let path = std::path::PathBuf::from("/fake");
        let result = runner.run(&path, &[]).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no more responses in queue"));
    }

    #[tokio::test]
    async fn process_output_fields_correctly_propagated() {
        let runner = MockCommandRunner::new(vec![Ok(ProcessOutput {
            stdout: "hello world\n".to_string(),
            success: true,
            exit_code: Some(42),
        })]);

        let path = std::path::PathBuf::from("/fake");
        let output = runner.run(&path, &[]).await.unwrap();
        assert_eq!(output.stdout, "hello world\n");
        assert!(output.success);
        assert_eq!(output.exit_code, Some(42));
    }
}
