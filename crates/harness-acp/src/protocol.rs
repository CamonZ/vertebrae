use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

use futures::StreamExt;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};
use vertebrae_harness_core::{HarnessError, ReapMode, reap_process_tree, signal_process_group};

const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

pub(crate) struct Process {
    child: Child,
    stdin: ChildStdin,
    stdout: FramedRead<ChildStdout, LinesCodec>,
}

impl Process {
    pub(crate) fn spawn(
        executable: &Path,
        args: &[String],
        environment: &BTreeMap<String, String>,
        cwd: &Path,
    ) -> Result<Self, HarnessError> {
        let mut command = Command::new(executable);
        command
            .args(args)
            .envs(environment)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            HarnessError::Unavailable(format!("Could not launch ACP agent: {error}"))
        })?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        Ok(Self {
            child,
            stdin,
            stdout: FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_MESSAGE_BYTES)),
        })
    }

    pub(crate) async fn read(&mut self) -> Result<Value, HarnessError> {
        let line = self
            .stdout
            .next()
            .await
            .ok_or_else(|| operation("ACP agent closed its output"))?
            .map_err(|error| match error {
                LinesCodecError::MaxLineLengthExceeded => {
                    operation("ACP message exceeds the size limit")
                }
                LinesCodecError::Io(error) => {
                    operation(format!("Could not read ACP output: {error}"))
                }
            })?;
        let message: Value = serde_json::from_str(&line)
            .map_err(|_| operation("ACP agent returned invalid JSON"))?;
        if message["jsonrpc"] != "2.0" {
            return Err(operation("ACP agent returned an invalid JSON-RPC envelope"));
        }
        Ok(message)
    }

    pub(crate) async fn write(&mut self, value: Value) -> Result<(), HarnessError> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| operation("Could not encode ACP message"))?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(operation("ACP message exceeds the size limit"));
        }
        bytes.push(b'\n');
        timeout(Duration::from_secs(5), self.stdin.write_all(&bytes))
            .await
            .map_err(|_| operation("ACP agent stopped reading input"))?
            .map_err(|_| operation("Could not write to ACP agent"))
    }

    pub(crate) async fn reject(&mut self, id: &Value) -> Result<(), HarnessError> {
        self.write(json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": "Client method unavailable" }
        }))
        .await
    }

    pub(crate) async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, HarnessError> {
        self.write(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .await?;
        loop {
            let message = self.read().await?;
            if message["id"].as_u64() == Some(id) && message.get("method").is_none() {
                return response(message, method);
            }
            if message.get("method").is_some()
                && let Some(id) = message.get("id")
            {
                self.reject(id).await?;
            }
        }
    }

    pub(crate) async fn reap(&mut self) {
        let _ = reap_process_tree(
            &mut self.child,
            Duration::from_secs(2),
            ReapMode::SignalFirst,
        )
        .await;
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        signal_process_group(self.child.id(), true);
    }
}

pub(crate) fn response(mut message: Value, method: &str) -> Result<Value, HarnessError> {
    if let Some(error) = message.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .ok_or_else(|| operation(format!("ACP {method} returned an invalid error code")))?;
        if !error.get("message").is_some_and(Value::is_string) {
            return Err(operation(format!(
                "ACP {method} returned a malformed error message"
            )));
        }
        if code == -32000 {
            return Err(operation(
                "ACP agent requires authentication. Sign in using the agent, then retry.",
            ));
        }
        // Provider error text can contain credentials or private request data.
        return Err(operation(format!("ACP {method} failed (code {code})")));
    }
    message
        .as_object_mut()
        .and_then(|fields| fields.remove("result"))
        .ok_or_else(|| operation(format!("ACP {method} response is missing its result")))
}

pub(crate) fn operation(message: impl Into<String>) -> HarnessError {
    HarnessError::Operation(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_malformed_codes_from_zero_without_exposing_agent_text() {
        for error in [
            json!({"message": "bad"}),
            json!({"code": "0", "message": "bad"}),
        ] {
            let error = response(json!({"error": error}), "initialize").unwrap_err();
            assert!(error.to_string().contains("invalid error code"));
        }
        let error = response(
            json!({"error": {"code": 0, "message": "private data"}}),
            "initialize",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("code 0"));
        assert!(!error.contains("private data"));
    }
}
