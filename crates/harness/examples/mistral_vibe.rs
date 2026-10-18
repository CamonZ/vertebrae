//! One fresh text turn over Vibe 2.26.1 stdio. See mistral_vibe.md beside this file.

use std::{env, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};
use vertebrae_harness_core::{ReapMode, reap_process_tree};

type Result<T> = std::result::Result<T, String>;
const MAX_BYTES: usize = 1024 * 1024;
const STARTUP: Duration = Duration::from_secs(30);
const TURN: Duration = Duration::from_secs(120);
const CLEANUP: Duration = Duration::from_secs(2);

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Mistral Vibe diagnostic failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let prompt = args.next().ok_or("usage: mistral_vibe 'text prompt'")?;
    if prompt.trim().is_empty() || prompt.len() > MAX_BYTES || args.next().is_some() {
        return Err("supply exactly one nonempty text prompt (at most 1 MiB)".into());
    }
    let home = tempfile::tempdir().map_err(|_| "cannot create temporary Vibe home")?;
    let workspace = tempfile::tempdir().map_err(|_| "cannot create temporary workspace")?;
    let executable = env::var_os("MISTRAL_VIBE_SERVER").unwrap_or_else(|| "vibe-app-server".into());
    let mut command = Command::new(executable);
    command
        .current_dir(workspace.path())
        .env("VIBE_HOME", home.path())
        .env("VIBE_ENABLE_TELEMETRY", "false")
        .env("VIBE_ENABLE_UPDATE_CHECKS", "false")
        .env("VIBE_ENABLE_SUBAGENTS", "false")
        .env("VIBE_ENABLE_BACKGROUND_PROCESSES", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Provider logs can contain credentials. Discard rather than echo them.
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        "cannot launch vibe-app-server; install Vibe 2.26.1 or set MISTRAL_VIBE_SERVER".to_owned()
    })?;
    let (Some(writer), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        reap_process_tree(&mut child, CLEANUP, ReapMode::SignalFirst).await;
        return Err("server pipes unavailable".into());
    };
    let mut client = Client {
        writer,
        reader: BufReader::new(stdout),
        entries: Vec::new(),
        session_id: None,
        turn_id: None,
    };
    // Cancellation drops only protocol work; the outer owner always reaps the child.
    let outcome = tokio::select! {
        result = client.one_turn(workspace.path(), &prompt) => result,
        _ = tokio::signal::ctrl_c() => Err("interrupted by Ctrl-C".into()),
    };
    if let Some(session_id) = client.session_id.clone() {
        // Best effort even after failure. Forced termination below is the fallback.
        let _stop = timeout(
            CLEANUP,
            client.request(4, "session/stop", json!({"sessionId": session_id})),
        )
        .await;
    }
    drop(client);
    let reaped = reap_process_tree(&mut child, CLEANUP, ReapMode::WaitThenSignal).await;
    let status = reaped
        .status
        .ok_or("server could not be reaped within the cleanup deadline")?;
    let text = outcome.map_err(|error| format!("{error}; server exit: {status}"))?;
    if !status.success() && !reaped.forced {
        return Err(format!("server exited unsuccessfully: {status}"));
    }
    println!("{text}");
    eprintln!("Outcome: completed; server reaped; temporary home/workspace removed on exit");
    Ok(())
}

struct Client<W, R> {
    writer: W,
    reader: R,
    entries: Vec<Value>,
    session_id: Option<String>,
    turn_id: Option<String>,
}

impl<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin> Client<W, R> {
    async fn one_turn(&mut self, cwd: &std::path::Path, prompt: &str) -> Result<String> {
        timeout(STARTUP, self.start(cwd))
            .await
            .map_err(|_| "startup timed out (30s)")??;
        timeout(TURN, self.turn(prompt))
            .await
            .map_err(|_| "turn timed out (120s)")?
    }

    async fn start(&mut self, cwd: &std::path::Path) -> Result<()> {
        let initialized = self
            .request(1, "initialize", json!({"clientInfo": {"name": "vertebrae-vibe-poc", "version": "0.1"}, "capabilities": {}}))
            .await?;
        if initialized
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            != Some("2.26.1")
        {
            return Err("this POC requires vibe-app-server 2.26.1".into());
        }
        eprintln!("Connected: vibe-app-server 2.26.1");
        self.write(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}))
            .await?;
        let opened = self
            .request(
                2,
                "session/start",
                json!({"agentConfig": {
                    "cwd": cwd, "enabledTools": [], "headless": true,
                    "autoApprove": false, "trustWorkspace": false
                }}),
            )
            .await?;
        self.session_id = Some(string_at(&opened, "/state/session/id")?.to_owned());
        Ok(())
    }

    async fn turn(&mut self, prompt: &str) -> Result<String> {
        let started = self
            .request(
                3,
                "turn/start",
                json!({
                    "sessionId": self.session_id,
                    "message": [{"type": "text", "text": prompt}]
                }),
            )
            .await?;
        self.turn_id = Some(string_at(&started, "/turn/id")?.to_owned());
        loop {
            let message = self.read().await?;
            if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
                let params = &message["params"];
                self.check_session(params)?;
                if Some(string_at(params, "/turn/id")?) != self.turn_id.as_deref() {
                    return Err("terminal event belongs to an unexpected turn".into());
                }
                let turn = &params["turn"];
                if turn["status"] != "completed"
                    || !turn["stopReason"].is_null()
                    || !turn["error"].is_null()
                {
                    return Err("turn did not finish successfully (failed, interrupted, limit, length or refusal)".into());
                }
                return self.text();
            }
            self.notification(&message)?;
        }
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        loop {
            let message = self.read().await?;
            if message.get("id").is_some() && message.get("method").is_none() {
                if message["id"] != id {
                    return Err("unexpected JSON-RPC response id".into());
                }
                if message.get("error").is_some() {
                    // Never echo arbitrary provider messages, which may include secrets.
                    if message.pointer("/error/code").and_then(Value::as_str)
                        == Some("unauthorized")
                    {
                        return Err(format!(
                            "{method} unauthorized; supply MISTRAL_API_KEY in the caller environment"
                        ));
                    }
                    return Err(format!(
                        "{method} rejected; check credentials/network/configuration (provider details withheld)"
                    ));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or("JSON-RPC response missing result".into());
            }
            self.notification(&message)?;
        }
    }

    async fn write(&mut self, message: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&message).map_err(|_| "cannot encode request")?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .await
            .map_err(|_| "server stdin write failed")?;
        self.writer
            .flush()
            .await
            .map_err(|_| "server stdin flush failed".into())
    }

    async fn read(&mut self) -> Result<Value> {
        let mut bytes = Vec::new();
        (&mut self.reader)
            .take((MAX_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "server stdout read failed")?;
        if bytes.is_empty() {
            return Err("server closed stdout before completing the protocol".into());
        }
        if bytes.len() > MAX_BYTES || bytes.last() != Some(&b'\n') {
            return Err("oversize or unterminated JSON-RPC record".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid JSON-RPC output")?;
        if !value.is_object() || value["jsonrpc"] != "2.0" {
            return Err("invalid JSON-RPC envelope".into());
        }
        Ok(value)
    }

    fn check_session(&self, params: &Value) -> Result<()> {
        if Some(string_at(params, "/sessionId")?) != self.session_id.as_deref() {
            return Err("event belongs to an unexpected session".into());
        }
        Ok(())
    }

    fn notification(&mut self, message: &Value) -> Result<()> {
        let method = string_at(message, "/method")?;
        if message.get("id").is_some() {
            return Err(
                "server requested a callback/client tool; unsupported in this text-only POC".into(),
            );
        }
        let params = &message["params"];
        match method {
            "history/entryAdded" => {
                self.check_session(params)?;
                let entry = &params["entry"];
                if matches!(entry["type"].as_str(), Some("callback" | "effect")) {
                    return Err(
                        "tool/approval/question activity is unsupported in this text-only POC"
                            .into(),
                    );
                }
                // Retain only assistant message entries, never reasoning/tool output.
                if entry["type"] == "message" && entry["role"] == "assistant" {
                    string_at(entry, "/id")?;
                    self.entries.push(entry.clone());
                }
            }
            "history/entryUpdated" => {
                self.check_session(params)?;
                let id = string_at(params, "/entryId")?;
                if let Some(entry) = self.entries.iter_mut().find(|entry| entry["id"] == id) {
                    apply_patch(entry, &params["patch"])?;
                }
            }
            "session/snapshot" => {
                self.check_session(params)?;
                if params
                    .pointer("/state/historyBeforeCursor")
                    .is_some_and(|v| !v.is_null())
                {
                    return Err("snapshot needs history paging; unsupported in this POC".into());
                }
                if let Some(history) = params.pointer("/state/history").and_then(Value::as_array) {
                    self.entries.clear();
                    for entry in history {
                        self.notification(&json!({"method": "history/entryAdded", "params": {
                            "sessionId": self.session_id, "entry": entry
                        }}))?;
                    }
                }
            }
            "session/compacted" | "session/contextCleared" => {
                return Err(
                    "session snapshot/resync/handoff is unsupported in this one-turn POC".into(),
                );
            }
            "server/error" => return Err("Vibe reported a server error (details withheld)".into()),
            _ => {} // Resource/status/statistics notifications are not needed here.
        }
        if serde_json::to_vec(&self.entries)
            .map_err(|_| "cannot measure response")?
            .len()
            > MAX_BYTES
        {
            return Err("assistant response exceeds the 1 MiB POC limit".into());
        }
        Ok(())
    }

    fn text(&self) -> Result<String> {
        let mut text = Vec::new();
        for entry in &self.entries {
            if entry["generationStatus"] != "completed" {
                return Err("assistant message remained incomplete".into());
            }
            for block in entry["content"]
                .as_array()
                .ok_or("assistant content missing")?
            {
                if block["type"] == "text" {
                    text.push(string_at(block, "/text")?);
                }
            }
        }
        let text = text.join("\n\n");
        if text.trim().is_empty() {
            return Err("turn completed without assistant text".into());
        }
        Ok(text)
    }
}

fn string_at<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing/invalid protocol field: {pointer}"))
}

// Vibe adds a string-only `append` operation to JSON Patch (upstream _patch.py).
fn apply_patch(entry: &mut Value, patches: &Value) -> Result<()> {
    for operation in patches.as_array().ok_or("history patch must be an array")? {
        let mut operation = operation.clone();
        if operation["op"] == "append" {
            let path = string_at(&operation, "/path")?;
            let previous = entry
                .pointer(path)
                .and_then(Value::as_str)
                .ok_or("append target is not text")?;
            let suffix = string_at(&operation, "/value")?;
            let combined = format!("{previous}{suffix}");
            if combined.len() > MAX_BYTES {
                return Err("assistant response exceeds the 1 MiB POC limit".into());
            }
            operation["op"] = json!("replace");
            operation["value"] = json!(combined);
        }
        let patch: json_patch::Patch =
            serde_json::from_value(json!([operation])).map_err(|_| "invalid history patch")?;
        json_patch::patch(entry, &patch).map_err(|_| "cannot apply history patch")?;
    }
    Ok(())
}
