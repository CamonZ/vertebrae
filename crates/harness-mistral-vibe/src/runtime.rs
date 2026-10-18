use std::{path::Path, process::Stdio, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::watch,
    time::timeout,
};
use vertebrae_harness_core::{
    CompletionStatus, ControlSink, EventCorrelation, EventSequencer, EventSink,
    HarnessCapabilities, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessRuntime,
    OutcomeMetrics, QuestionCapabilities, RunHandle, RunId, RunOutcome, RunRequest,
    SequencedEventSink, SessionHandle, StartSessionRequest, TextEvent, ThreadId, TurnInput,
    TurnInputProvenance, UpdateSemantics,
};
use vertebrae_harness_core::{ReapMode, reap_process_tree};

use crate::{
    MistralVibeConfig,
    protocol::{MAX_BYTES, ModelCatalog, apply_patch, model_name, parse_catalog, string_at},
};

#[derive(Clone)]
pub struct MistralVibeRuntime {
    config: MistralVibeConfig,
}

impl MistralVibeRuntime {
    pub fn new(config: MistralVibeConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &MistralVibeConfig {
        &self.config
    }

    pub async fn discover(&self) -> Result<ModelCatalog, HarnessError> {
        let mut process = OwnedProcess::spawn(&self.config, None).await?;
        let result = async {
            timeout(self.config.startup_timeout, async {
                process.client.initialize(&self.config).await?;
                let config = process.client.request(2, "config/read", json!({})).await?;
                parse_catalog(&config)
            })
            .await
            .map_err(|_| HarnessError::Unavailable("Mistral Vibe startup timed out".into()))?
        }
        .await;
        process.shutdown().await?;
        result
    }
}

impl std::fmt::Debug for MistralVibeRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MistralVibeRuntime")
            .field("config", &self.config)
            .finish()
    }
}

#[derive(Debug, Clone, Default)]
enum OutcomeState {
    #[default]
    Pending,
    Ready(RunOutcome),
    Failed(String),
}

struct MistralVibeRunHandle {
    run_id: RunId,
    cancel_tx: watch::Sender<bool>,
    outcome_rx: watch::Receiver<OutcomeState>,
}

#[async_trait]
impl RunHandle for MistralVibeRunHandle {
    fn run_id(&self) -> &RunId {
        &self.run_id
    }

    async fn cancel(&self) -> Result<(), HarnessError> {
        let _ = self.cancel_tx.send(true);
        Ok(())
    }

    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        let mut receiver = self.outcome_rx.clone();
        loop {
            let state = { receiver.borrow().clone() };
            match state {
                OutcomeState::Pending => {
                    receiver.changed().await.map_err(|_| {
                        HarnessError::Operation(
                            "Mistral Vibe run ended without a terminal outcome".into(),
                        )
                    })?;
                }
                OutcomeState::Ready(outcome) => return Ok(outcome),
                OutcomeState::Failed(message) => {
                    return Err(HarnessError::Operation(message));
                }
            }
        }
    }
}

#[async_trait]
impl HarnessRuntime for MistralVibeRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        let catalog = self.discover().await?;
        Ok(HarnessCapabilities {
            provider: "mistral-vibe".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: false,
            one_shot_runs: true,
            structured_inference: false,
            session_resumption: false,
            default_model: Some(catalog.default_model),
            models: catalog.models,
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: Default::default(),
            questions: QuestionCapabilities::default(),
        })
    }

    async fn start_session(
        &self,
        _request: StartSessionRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        Err(HarnessError::Unsupported(
            "Mistral Vibe currently supports one-shot runs; persistent sessions are unsupported"
                .into(),
        ))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        validate_request(&request)?;
        let handle_run_id = request.run_id.clone();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (outcome_tx, outcome_rx) = watch::channel(OutcomeState::Pending);
        tokio::spawn(execute_run(
            self.config.clone(),
            request,
            event_sink,
            cancel_rx,
            outcome_tx,
        ));
        Ok(Arc::new(MistralVibeRunHandle {
            run_id: handle_run_id,
            cancel_tx,
            outcome_rx,
        }))
    }
}

fn validate_request(request: &RunRequest) -> Result<(), HarnessError> {
    let config = &request.config;
    if let Some(directory) = &config.working_directory
        && !directory.is_dir()
    {
        return Err(HarnessError::InvalidRequest(format!(
            "working directory is not a directory: {}",
            directory.display()
        )));
    }
    if config.reasoning_effort.is_some()
        || config.speed_tier.is_some()
        || config.personality.is_some()
        || config.verbosity.is_some()
        || config.output_schema.is_some()
        || config.developer_instructions.is_some()
        || !config.environment.is_empty()
    {
        return Err(HarnessError::Unsupported(
            "Mistral Vibe supports only working_directory and model in RequestConfig".into(),
        ));
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > MAX_BYTES {
        return Err(HarnessError::InvalidRequest(
            "Mistral Vibe prompt must be nonempty and at most 1 MiB".into(),
        ));
    }
    Ok(())
}

async fn execute_run(
    config: MistralVibeConfig,
    request: RunRequest,
    event_sink: Arc<dyn EventSink>,
    mut cancel_rx: watch::Receiver<bool>,
    outcome_tx: watch::Sender<OutcomeState>,
) {
    let run_id = request.run_id.clone();
    let thread_id = ThreadId::new(request.run_id.as_str());
    let correlation = EventCorrelation {
        thread_id: Some(thread_id.clone()),
        run_id: Some(run_id.clone()),
        ..EventCorrelation::default()
    };
    let sequenced = SequencedEventSink::new(Arc::new(EventSequencer::default()), event_sink);
    if emit_input(&sequenced, &request, thread_id).await.is_err() {
        let _ = outcome_tx.send(OutcomeState::Failed(
            "event sink rejected the Mistral Vibe input event".into(),
        ));
        return;
    }

    let execution = async {
        if *cancel_rx.borrow() {
            return cancelled_outcome();
        }
        let mut process =
            match OwnedProcess::spawn(&config, request.config.working_directory.as_deref()).await {
                Ok(process) => process,
                Err(error) => return failed_outcome(error.to_string()),
            };
        let turn = tokio::select! {
            biased;
            _ = cancel_rx.changed(), if *cancel_rx.borrow() => Err(cancelled_error()),
            result = async {
                timeout(config.startup_timeout, async {
                    process.client.initialize(&config).await?;
                    let catalog = process.client.request(2, "config/read", json!({})).await?;
                    let active_alias = catalog
                        .pointer("/config/activeModel/alias")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            HarnessError::Operation("invalid Mistral Vibe configuration".into())
                        })?;
                    let alias = request.config.model.as_deref().unwrap_or(active_alias);
                    let model = model_name(&catalog, alias)?;
                    process.client.start_session(alias, model).await
                })
                .await
                .map_err(|_| HarnessError::Unavailable("Mistral Vibe startup timed out".into()))??;
                timeout(config.turn_timeout, process.client.one_turn(&request.prompt))
                    .await
                    .map_err(|_| HarnessError::Operation("Mistral Vibe turn timed out".into()))?
            } => result,
        };
        let mut outcome = match turn {
            Ok(text) => completed_outcome(text),
            Err(error) if is_cancelled(&error) => cancelled_outcome(),
            Err(error) => failed_outcome(error.to_string()),
        };
        let shutdown = process.shutdown().await;
        if outcome.status == CompletionStatus::Completed
            && let Err(error) = shutdown
        {
            outcome = failed_outcome(error.to_string());
        }
        outcome
    };

    let outcome = execution.await;

    if outcome.status == CompletionStatus::Completed
        && let Some(text) = outcome.result_text.clone()
        && emit_text(&sequenced, &request, &correlation, text)
            .await
            .is_err()
    {
        let _ = outcome_tx.send(OutcomeState::Failed(
            "event sink rejected the Mistral Vibe output event".into(),
        ));
        return;
    }
    if emit_finished(&sequenced, request.stream_id, correlation, outcome.clone())
        .await
        .is_err()
    {
        let _ = outcome_tx.send(OutcomeState::Failed(
            "event sink rejected the Mistral Vibe terminal event".into(),
        ));
        return;
    }
    let _ = outcome_tx.send(OutcomeState::Ready(outcome));
}

fn completed_outcome(text: String) -> RunOutcome {
    RunOutcome {
        status: CompletionStatus::Completed,
        result_text: Some(text),
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: None,
    }
}

fn cancelled_outcome() -> RunOutcome {
    RunOutcome {
        status: CompletionStatus::Cancelled,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: None,
    }
}

fn cancelled_error() -> HarnessError {
    HarnessError::Operation("__mistral_vibe_cancelled".into())
}

fn is_cancelled(error: &HarnessError) -> bool {
    matches!(error, HarnessError::Operation(message) if message == "__mistral_vibe_cancelled")
}

fn failed_outcome(error: String) -> RunOutcome {
    RunOutcome {
        status: CompletionStatus::Failed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: Some(error),
    }
}

async fn emit_input(
    sink: &SequencedEventSink,
    request: &RunRequest,
    thread_id: ThreadId,
) -> Result<(), HarnessError> {
    let correlation = EventCorrelation {
        thread_id: Some(thread_id.clone()),
        run_id: Some(request.run_id.clone()),
        ..EventCorrelation::default()
    };
    let mut draft = HarnessEventDraftV1::new(
        request.stream_id.clone(),
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id,
            run_id: Some(request.run_id.clone()),
            content: request.prompt.clone(),
            provenance: TurnInputProvenance::Human,
        }),
    );
    draft.correlation = correlation;
    sink.emit(draft).await.map(|_| ())
}

async fn emit_text(
    sink: &SequencedEventSink,
    request: &RunRequest,
    correlation: &EventCorrelation,
    text: String,
) -> Result<(), HarnessError> {
    let mut draft = HarnessEventDraftV1::new(
        request.stream_id.clone(),
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::Text(TextEvent {
            text,
            completion_status: Some(CompletionStatus::Completed),
        }),
    );
    draft.correlation = correlation.clone();
    sink.emit(draft).await.map(|_| ())
}

async fn emit_finished(
    sink: &SequencedEventSink,
    stream_id: vertebrae_harness_core::StreamId,
    correlation: EventCorrelation,
    outcome: RunOutcome,
) -> Result<(), HarnessError> {
    let mut draft = HarnessEventDraftV1::new(
        stream_id,
        UpdateSemantics::Snapshot,
        HarnessEventPayloadV1::RunFinished(outcome),
    );
    draft.correlation = correlation;
    sink.emit(draft).await.map(|_| ())
}

struct OwnedProcess {
    child: Child,
    _home: TempDir,
    _workspace: Option<TempDir>,
    client: Client,
}

impl OwnedProcess {
    async fn spawn(
        config: &MistralVibeConfig,
        working_directory: Option<&Path>,
    ) -> Result<Self, HarnessError> {
        let executable = config.resolve_executable()?;
        let home = tempfile::tempdir().map_err(|_| {
            HarnessError::Unavailable("cannot create temporary Mistral Vibe home".into())
        })?;
        let workspace = if working_directory.is_some() {
            None
        } else {
            Some(tempfile::tempdir().map_err(|_| {
                HarnessError::Unavailable("cannot create temporary Mistral Vibe workspace".into())
            })?)
        };
        let cwd = working_directory.map(Path::to_path_buf).unwrap_or_else(|| {
            workspace
                .as_ref()
                .expect("workspace exists")
                .path()
                .to_path_buf()
        });
        let mut command = Command::new(executable);
        command
            .current_dir(cwd)
            .env("VIBE_HOME", home.path())
            .env("VIBE_ENABLE_TELEMETRY", "false")
            .env("VIBE_ENABLE_UPDATE_CHECKS", "false")
            .env("VIBE_ENABLE_SUBAGENTS", "false")
            .env("VIBE_ENABLE_BACKGROUND_PROCESSES", "false")
            .envs(&config.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| {
            HarnessError::Unavailable(
                "cannot launch vibe-app-server; install mistral-vibe 2.26.1 or set MISTRAL_VIBE_SERVER".into(),
            )
        })?;
        let (Some(writer), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ =
                reap_process_tree(&mut child, config.cleanup_timeout, ReapMode::SignalFirst).await;
            return Err(HarnessError::Operation(
                "Mistral Vibe server pipes unavailable".into(),
            ));
        };
        Ok(Self {
            child,
            _home: home,
            _workspace: workspace,
            client: Client {
                writer: Box::new(writer),
                reader: BufReader::new(stdout),
                entries: Vec::new(),
                session_id: None,
                turn_id: None,
                terminal_event: None,
            },
        })
    }

    async fn shutdown(&mut self) -> Result<(), HarnessError> {
        let config_cleanup_timeout = Duration::from_secs(2);
        if let Some(session_id) = self.client.session_id.clone() {
            let _ = timeout(
                config_cleanup_timeout,
                self.client
                    .request(4, "session/stop", json!({"sessionId": session_id})),
            )
            .await;
        }
        let _ = self.client.close().await;
        let outcome = reap_process_tree(
            &mut self.child,
            config_cleanup_timeout,
            ReapMode::WaitThenSignal,
        )
        .await;
        match outcome.status {
            Some(status) if status.success() || outcome.forced => Ok(()),
            Some(status) => Err(HarnessError::Operation(format!(
                "Mistral Vibe server exited unsuccessfully: {status}"
            ))),
            None => Err(HarnessError::Operation(
                "Mistral Vibe server did not terminate within the cleanup deadline".into(),
            )),
        }
    }
}

struct Client {
    writer: Box<dyn AsyncWrite + Send + Unpin>,
    reader: BufReader<tokio::process::ChildStdout>,
    entries: Vec<Value>,
    session_id: Option<String>,
    turn_id: Option<String>,
    terminal_event: Option<Value>,
}

impl Client {
    async fn initialize(&mut self, config: &MistralVibeConfig) -> Result<(), HarnessError> {
        let initialized = self
            .request(
                1,
                "initialize",
                json!({
                    "clientInfo": {"name": "vertebrae", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {}
                }),
            )
            .await?;
        if string_at(&initialized, "/serverInfo/version")? != config.required_version {
            return Err(HarnessError::Unavailable(format!(
                "Mistral Vibe harness requires version {}; set MISTRAL_VIBE_SERVER to a compatible executable",
                config.required_version
            )));
        }
        self.write(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}))
            .await
    }

    async fn start_session(&mut self, _alias: &str, model: &str) -> Result<(), HarnessError> {
        let opened = self
            .request(
                3,
                "session/start",
                json!({
                    "agentConfig": {
                        "completion": {"type": "mistral", "model": model},
                        "enabledTools": [],
                        "headless": true,
                        "autoApprove": false,
                        "trustWorkspace": false
                    }
                }),
            )
            .await?;
        self.session_id = Some(string_at(&opened, "/state/session/id")?.to_owned());
        Ok(())
    }

    async fn one_turn(&mut self, prompt: &str) -> Result<String, HarnessError> {
        let started = self
            .request(
                5,
                "turn/start",
                json!({
                    "sessionId": self.session_id,
                    "message": [{"type": "text", "text": prompt}]
                }),
            )
            .await?;
        self.turn_id = Some(string_at(&started, "/turn/id")?.to_owned());
        loop {
            let message = match self.terminal_event.take() {
                Some(message) => message,
                None => self.read().await?,
            };
            if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
                return self.finish_turn(&message["params"]);
            }
            self.notification(&message)?;
        }
    }

    fn finish_turn(&self, params: &Value) -> Result<String, HarnessError> {
        self.check_session(params)?;
        if Some(string_at(params, "/turn/id")?) != self.turn_id.as_deref() {
            return Err(HarnessError::Operation(
                "Mistral Vibe terminal event belongs to an unexpected turn".into(),
            ));
        }
        let turn = &params["turn"];
        if turn["status"] != "completed"
            || !turn["stopReason"].is_null()
            || !turn["error"].is_null()
        {
            return Err(HarnessError::Operation(
                "Mistral Vibe turn did not complete successfully".into(),
            ));
        }
        let mut text = Vec::new();
        for entry in &self.entries {
            if entry["generationStatus"] != "completed" {
                return Err(HarnessError::Operation(
                    "Mistral Vibe assistant message remained incomplete".into(),
                ));
            }
            for block in entry["content"].as_array().ok_or_else(|| {
                HarnessError::Operation("invalid Mistral Vibe assistant content".into())
            })? {
                if block["type"] == "text" {
                    text.push(string_at(block, "/text")?.to_owned());
                }
            }
        }
        let text = text.join("\n\n");
        if text.trim().is_empty() {
            return Err(HarnessError::Operation(
                "Mistral Vibe turn completed without assistant text".into(),
            ));
        }
        Ok(text)
    }

    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, HarnessError> {
        self.write(json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))
        .await?;
        loop {
            let message = self.read().await?;
            if message.get("id").is_some() && message.get("method").is_none() {
                if message["id"] != id {
                    return Err(HarnessError::Operation(
                        "unexpected Mistral Vibe response id".into(),
                    ));
                }
                if message.get("error").is_some() {
                    return Err(rpc_error(method));
                }
                return message.get("result").cloned().ok_or_else(|| {
                    HarnessError::Operation("Mistral Vibe response missing result".into())
                });
            }
            if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
                if self.terminal_event.replace(message).is_some() {
                    return Err(HarnessError::Operation(
                        "Mistral Vibe sent multiple terminal turn events".into(),
                    ));
                }
                continue;
            }
            self.notification(&message)?;
        }
    }

    async fn write(&mut self, message: Value) -> Result<(), HarnessError> {
        let mut bytes = serde_json::to_vec(&message)
            .map_err(|_| HarnessError::Operation("cannot encode Mistral Vibe request".into()))?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .await
            .map_err(|_| HarnessError::Operation("Mistral Vibe stdin write failed".into()))?;
        self.writer
            .flush()
            .await
            .map_err(|_| HarnessError::Operation("Mistral Vibe stdin flush failed".into()))
    }

    async fn read(&mut self) -> Result<Value, HarnessError> {
        let mut bytes = Vec::new();
        let count = (&mut self.reader)
            .take((MAX_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| HarnessError::Operation("Mistral Vibe stdout read failed".into()))?;
        if count == 0 {
            return Err(HarnessError::Operation(
                "Mistral Vibe closed stdout before completing the protocol".into(),
            ));
        }
        if bytes.len() > MAX_BYTES || bytes.last() != Some(&b'\n') {
            return Err(HarnessError::Operation(
                "oversize or unterminated Mistral Vibe JSON-RPC record".into(),
            ));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| HarnessError::Operation("invalid Mistral Vibe JSON-RPC output".into()))?;
        if !value.is_object() || value["jsonrpc"] != "2.0" {
            return Err(HarnessError::Operation(
                "invalid Mistral Vibe JSON-RPC envelope".into(),
            ));
        }
        Ok(value)
    }

    fn check_session(&self, params: &Value) -> Result<(), HarnessError> {
        if Some(string_at(params, "/sessionId")?) != self.session_id.as_deref() {
            return Err(HarnessError::Operation(
                "Mistral Vibe event belongs to an unexpected session".into(),
            ));
        }
        Ok(())
    }

    fn notification(&mut self, message: &Value) -> Result<(), HarnessError> {
        let method = string_at(message, "/method")?;
        if message.get("id").is_some() {
            return Err(HarnessError::Unsupported(
                "Mistral Vibe requested a callback or client tool".into(),
            ));
        }
        let params = &message["params"];
        match method {
            "history/entryAdded" => {
                self.check_session(params)?;
                let entry = &params["entry"];
                if matches!(entry["type"].as_str(), Some("callback" | "effect")) {
                    return Err(HarnessError::Unsupported(
                        "tools and approvals are unsupported by the Mistral Vibe harness".into(),
                    ));
                }
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
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(HarnessError::Unsupported(
                        "Mistral Vibe history paging is unsupported".into(),
                    ));
                }
                if let Some(history) = params.pointer("/state/history").and_then(Value::as_array) {
                    self.entries.clear();
                    for entry in history {
                        self.notification(&json!({
                            "method": "history/entryAdded",
                            "params": {"sessionId": self.session_id, "entry": entry}
                        }))?;
                    }
                }
            }
            "session/compacted" | "session/contextCleared" => {
                return Err(HarnessError::Unsupported(
                    "Mistral Vibe session resynchronization is unsupported".into(),
                ));
            }
            "server/error" => {
                return Err(HarnessError::Operation(
                    "Mistral Vibe reported a server error".into(),
                ));
            }
            "runtime/diagnostics" | "session/ready" => {}
            _ => {
                return Err(HarnessError::Unsupported(format!(
                    "Mistral Vibe notification '{method}' is unsupported"
                )));
            }
        }
        if serde_json::to_vec(&self.entries)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
            > MAX_BYTES
        {
            return Err(HarnessError::Operation(
                "Mistral Vibe response exceeds 1 MiB".into(),
            ));
        }
        Ok(())
    }

    async fn close(&mut self) {
        let _ = self.writer.shutdown().await;
    }
}

fn rpc_error(method: &str) -> HarnessError {
    if method == "session/start" {
        HarnessError::Unavailable(
            "Mistral Vibe rejected the session; check MISTRAL_API_KEY, network, and model configuration".into(),
        )
    } else {
        HarnessError::Operation(format!(
            "Mistral Vibe rejected {method}; check credentials, network, and configuration"
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{Arc, Mutex},
    };

    use vertebrae_harness_core::{EventSink, HarnessEventV1};

    use super::*;

    #[derive(Default)]
    struct CaptureSink(Mutex<Vec<HarnessEventV1>>);

    #[async_trait]
    impl EventSink for CaptureSink {
        async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }

    #[tokio::test]
    async fn runs_one_turn_with_discovered_model_and_normalized_events() {
        let directory = tempfile::tempdir().unwrap();
        let server = directory.path().join("fake-vibe-server");
        std::fs::write(
            &server,
            r##"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        result = {"serverInfo": {"name": "vibe-app-server", "version": "2.26.1"}}
    elif method == "initialized":
        continue
    elif method == "config/read":
        result = {"config": {
            "defaultModelAlias": "medium",
            "activeModel": {"alias": "medium"},
            "models": [
                {"alias": "medium", "name": "mistral-medium-latest"},
                {"alias": "large", "name": "mistral-large-latest"}
            ]
        }}
    elif method == "session/start":
        assert request["params"]["agentConfig"]["completion"] == {
            "type": "mistral", "model": "mistral-large-latest"
        }
        result = {"state": {"session": {"id": "session"}}}
    elif method == "turn/start":
        result = {"turn": {"id": "turn"}}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "history/entryAdded", "params": {
            "sessionId": "session",
            "entry": {"id": "message", "type": "message", "role": "assistant", "generationStatus": "in_progress", "content": [{"type": "text", "text": "hello"}]}
        }}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "history/entryUpdated", "params": {
            "sessionId": "session", "entryId": "message", "patch": [
                {"op": "append", "path": "/content/0/text", "value": " world"}
            ]
        }}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "history/entryUpdated", "params": {
            "sessionId": "session", "entryId": "message", "patch": [
                {"op": "replace", "path": "/generationStatus", "value": "completed"}
            ]
        }}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "turn/completed", "params": {
            "sessionId": "session", "turn": {"id": "turn", "status": "completed", "stopReason": None, "error": None}
        }}), flush=True)
        continue
    elif method == "session/stop":
        result = {}
    else:
        raise AssertionError(method)
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();

        let runtime = MistralVibeRuntime::new(MistralVibeConfig {
            executable: Some(server),
            ..MistralVibeConfig::default()
        });
        let capabilities = runtime.capabilities().await.unwrap();
        assert_eq!(capabilities.default_model.as_deref(), Some("medium"));
        assert!(capabilities.models.iter().any(|model| model.id == "large"));

        let sink = Arc::new(CaptureSink::default());
        let handle = runtime
            .run_once(
                RunRequest {
                    run_id: RunId::new("run"),
                    stream_id: vertebrae_harness_core::StreamId::new("stream"),
                    prompt: "hello".into(),
                    config: vertebrae_harness_core::RequestConfig {
                        model: Some("large".into()),
                        ..Default::default()
                    },
                },
                sink.clone(),
                Arc::new(NoControlSink),
            )
            .await
            .unwrap();
        let outcome = handle.await_outcome().await.unwrap();

        assert_eq!(
            outcome.status,
            CompletionStatus::Completed,
            "{:?}",
            outcome.error
        );
        assert_eq!(outcome.result_text.as_deref(), Some("hello world"));
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].payload.event_type(), "turn_input");
        assert_eq!(events[1].payload.event_type(), "text");
        assert_eq!(events[2].payload.event_type(), "run_finished");
    }

    fn request(config: vertebrae_harness_core::RequestConfig) -> RunRequest {
        RunRequest {
            run_id: RunId::new("run"),
            stream_id: vertebrae_harness_core::StreamId::new("stream"),
            prompt: "hello".into(),
            config,
        }
    }

    #[tokio::test]
    #[ignore = "set MISTRAL_VIBE_SERVER and run with --ignored for an installed-server smoke test"]
    async fn real_server_reports_dynamic_capabilities() {
        let runtime = MistralVibeRuntime::new(MistralVibeConfig::default());
        let capabilities = runtime.capabilities().await.unwrap();

        assert!(capabilities.available);
        assert!(capabilities.models.iter().any(|model| !model.id.is_empty()));
        assert!(
            capabilities
                .default_model
                .as_deref()
                .is_some_and(|model| !model.is_empty())
        );
    }

    #[tokio::test]
    async fn turn_deadline_is_independent_from_startup_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let server = directory.path().join("slow-vibe-server");
        std::fs::write(
            &server,
            r#"#!/usr/bin/env python3
import json, sys, time
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialized":
        continue
    if method == "initialize":
        result = {"serverInfo": {"name": "vibe-app-server", "version": "2.26.1"}}
    elif method == "config/read":
        result = {"config": {
            "defaultModelAlias": "medium",
            "activeModel": {"alias": "medium"},
            "models": [{"alias": "medium", "name": "mistral-medium-latest"}]
        }}
    elif method == "session/start":
        result = {"state": {"session": {"id": "session"}}}
    elif method == "turn/start":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"turn": {"id": "turn"}}}), flush=True)
        time.sleep(0.1)
        print(json.dumps({"jsonrpc": "2.0", "method": "turn/completed", "params": {
            "sessionId": "session", "turn": {"id": "turn", "status": "completed", "stopReason": None, "error": None}
        }}), flush=True)
        continue
    elif method == "session/stop":
        result = {}
    else:
        raise AssertionError(method)
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();

        let runtime = MistralVibeRuntime::new(MistralVibeConfig {
            executable: Some(server),
            turn_timeout: Duration::from_millis(10),
            ..MistralVibeConfig::default()
        });
        let handle = runtime
            .run_once(
                RunRequest {
                    run_id: RunId::new("run"),
                    stream_id: vertebrae_harness_core::StreamId::new("stream"),
                    prompt: "hello".into(),
                    config: Default::default(),
                },
                Arc::new(CaptureSink::default()),
                Arc::new(NoControlSink),
            )
            .await
            .unwrap();
        let outcome = handle.await_outcome().await.unwrap();

        assert_eq!(outcome.status, CompletionStatus::Failed);
        assert!(
            outcome
                .error
                .as_deref()
                .is_some_and(|error| error.contains("turn timed out"))
        );
    }

    #[test]
    fn request_configuration_is_restricted_to_dynamic_model_and_workspace() {
        assert!(
            validate_request(&request(vertebrae_harness_core::RequestConfig {
                model: Some("future-vibe-alias".into()),
                ..Default::default()
            }))
            .is_ok()
        );

        let result = validate_request(&request(vertebrae_harness_core::RequestConfig {
            reasoning_effort: Some("high".into()),
            ..Default::default()
        }));
        assert!(
            matches!(result, Err(HarnessError::Unsupported(message)) if message.contains("Mistral Vibe"))
        );
    }

    struct NoControlSink;

    #[async_trait]
    impl vertebrae_harness_core::ControlSink for NoControlSink {
        async fn request(
            &self,
            _: vertebrae_harness_core::ControlRequestEnvelope,
        ) -> Result<vertebrae_harness_core::ControlResolution, HarnessError> {
            Err(HarnessError::Control("unexpected control request".into()))
        }
    }
}
