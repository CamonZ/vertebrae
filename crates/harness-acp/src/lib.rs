//! ACP v1 interactive sessions and one-shot runs over newline-delimited JSON-RPC.
mod config;
mod protocol;
mod session;
mod updates;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::timeout;
use vertebrae_harness_core::{
    ControlSink, EventSink, HarnessCapabilities, HarnessError, HarnessEventPayloadV1,
    HarnessRuntime, RequestConfig, RunHandle, RunRequest, SessionHandle, SessionMode,
    StartSessionRequest,
};

pub use config::{Discovery, SessionConfig};

/// A text message recovered from an adapter's session history.
#[derive(Debug, PartialEq, Eq)]
pub struct HistoryMessage {
    pub user: bool,
    pub text: String,
}
use protocol::{Process, operation};

type HistoryObserver<'a> = dyn FnMut(&Value) -> Result<(), HarnessError> + Send + 'a;

struct AgentSession {
    id: String,
    config: SessionConfig,
    supports_steering: bool,
    supports_resume: bool,
    supports_close: bool,
    initial_usage: Option<HarnessEventPayloadV1>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AcpRuntime {
    executable: PathBuf,
    args: Vec<String>,
    environment: BTreeMap<String, String>,
}

impl AcpRuntime {
    pub fn new(
        executable: PathBuf,
        args: Vec<String>,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            executable,
            args,
            environment,
        }
    }
    /// Probe a throwaway session for connection settings and model-dependent choices.
    pub async fn discover(&self) -> Result<Discovery, HarnessError> {
        let directory = tokio::task::spawn_blocking(tempfile::tempdir)
            .await
            .map_err(|_| operation("Could not prepare an ACP discovery workspace"))?
            .map_err(|error| {
                operation(format!(
                    "Could not create an ACP discovery workspace: {error}"
                ))
            })?;

        let (mut process, session) = self
            .open(Some(directory.path().into()), None, None, None)
            .await?;
        let AgentSession {
            id,
            config,
            supports_steering,
            supports_resume,
            ..
        } = session;
        let mut current = config.clone();
        let mut model_options = Vec::new();
        let _ = timeout(Duration::from_secs(10), async {
            for (index, choice) in config.choices("model").enumerate() {
                if current
                    .set(&mut process, index as u64 + 3, &id, "model", &choice.value)
                    .await
                    .is_ok()
                {
                    model_options.push((choice.value.clone(), current.clone()));
                }
            }
            if let Some(initial) = config.current("model") {
                let _ = current
                    .set(
                        &mut process,
                        config.choices("model").count() as u64 + 3,
                        &id,
                        "model",
                        initial,
                    )
                    .await;
            }
        })
        .await;
        process.reap().await;
        Ok(Discovery {
            config,
            model_options,
            supports_steering,
            supports_resume,
        })
    }

    /// Recover text for a previously cataloged chat that has no local transcript.
    pub async fn load_history(
        &self,
        directory: Option<PathBuf>,
        id: &str,
    ) -> Result<Vec<HistoryMessage>, HarnessError> {
        let mut messages: Vec<HistoryMessage> = Vec::new();
        let mut previous_id = None;
        let mut size = 0;
        let mut can_append = false;
        let mut record = |message: &Value| {
            let params = &message["params"];
            if message["method"] != "session/update" || params["sessionId"] != id {
                return Ok(());
            }
            let update = &params["update"];
            let user = match update["sessionUpdate"].as_str() {
                Some("user_message_chunk") => true,
                Some("agent_message_chunk") => false,
                Some("tool_call" | "tool_call_update") => {
                    can_append = false;
                    return Ok(());
                }
                _ => return Ok(()),
            };
            if update["content"]["type"] != "text" {
                return Ok(());
            }
            let Some(text) = update["content"]["text"].as_str() else {
                return Ok(());
            };
            size += text.len();
            if size > 16 * 1024 * 1024 || messages.len() >= 10_000 {
                return Err(operation("ACP history exceeds the replay limit"));
            }
            let message_id = update["messageId"].as_str();
            if let Some(previous) = messages.last_mut()
                && previous.user == user
                && previous_id.as_deref() == message_id
                && (can_append || message_id.is_some())
            {
                previous.text.push_str(text);
            } else {
                messages.push(HistoryMessage {
                    user,
                    text: text.to_owned(),
                });
            }
            previous_id = message_id.map(str::to_owned);
            can_append = true;
            Ok(())
        };
        let (mut process, _) = self
            .open(directory, Some(id), Some(&mut record), None)
            .await?;
        process.reap().await;
        Ok(messages)
    }

    async fn open(
        &self,
        directory: Option<PathBuf>,
        resume: Option<&str>,
        history: Option<&mut HistoryObserver<'_>>,
        cancel: Option<&mut tokio::sync::watch::Receiver<bool>>,
    ) -> Result<(Process, AgentSession), HarnessError> {
        let cwd = tokio::task::spawn_blocking(move || {
            directory
                .map_or_else(std::env::current_dir, Ok)
                .and_then(std::fs::canonicalize)
        })
        .await
        .map_err(|_| operation("Could not resolve ACP working directory"))?
        .map_err(|error| {
            HarnessError::InvalidRequest(format!("Invalid ACP working directory: {error}"))
        })?;
        let mut process = Process::spawn(&self.executable, &self.args, &self.environment, &cwd)?;
        let initialize = timeout(Duration::from_secs(30), async {
            let initialized = process.request(1, "initialize", json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name":"vertebrae", "title":"Vertebrae", "version":env!("CARGO_PKG_VERSION")}
            })).await?;
            if initialized["protocolVersion"] != 1 {
                return Err(HarnessError::Unsupported(
                    "ACP agent did not negotiate protocol version 1".into(),
                ));
            }
            let supports_load = initialized
                .pointer("/agentCapabilities/loadSession")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let supports_resume = initialized
                .pointer("/agentCapabilities/sessionCapabilities/resume")
                .is_some_and(serde_json::Value::is_object);
            let method = match (resume, history.is_some()) {
                (Some(_), true) if supports_load => "session/load",
                (_, true) => return Err(HarnessError::Unsupported("ACP adapter history replay".into())),
                (Some(_), false) if supports_resume => "session/resume",
                (Some(_), false) if supports_load => "session/load",
                (Some(_), false) => return Err(HarnessError::Unsupported(
                    "This ACP adapter cannot continue the saved conversation. Start a new chat to continue.".into(),
                )),
                (None, false) => "session/new",
            };
            let params = match resume {
                Some(id) => json!({"cwd":cwd, "sessionId":id, "mcpServers":[]}),
                None => json!({"cwd":cwd, "mcpServers":[]}),
            };
            let mut history = history;
            let mut initial_usage = None;
            let session = process
                .request_observing(2, method, params, |message| {
                    if let Some(record) = &mut history {
                        record(message)?;
                    }
                    let params = &message["params"];
                    if message["method"] == "session/update"
                        && let Some(session_id) = params["sessionId"].as_str()
                        && resume.is_none_or(|id| id == session_id)
                        && let Some((usage @ HarnessEventPayloadV1::Usage(_), _)) =
                            updates::update(&params["update"])
                    {
                        initial_usage = Some((session_id.to_owned(), usage));
                    }
                    Ok(())
                })
                .await?;
            let id = session["sessionId"]
                .as_str()
                .or(resume)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| operation("ACP agent returned no session ID"))?;
            if resume.is_some_and(|resume| resume != id) {
                return Err(operation(
                    "ACP agent returned a different session ID on resume",
                ));
            }
            let mut config = SessionConfig::default();
            config.replace(&session);
            let initial_usage = initial_usage
                .filter(|(session_id, _)| session_id == &id)
                .map(|(_, usage)| usage);
            Ok(AgentSession {
                id,
                config,
                supports_steering: config::supports_steering(&initialized),
                supports_resume: supports_resume || supports_load,
                supports_close: initialized
                    .pointer("/agentCapabilities/sessionCapabilities/close")
                    .is_some_and(Value::is_object),
                initial_usage,
            })
        });
        let result = tokio::select! {
            biased;
            _ = async {
                match cancel {
                    Some(cancel) => session::wait_for_signal(cancel).await,
                    None => std::future::pending().await,
                }
            } => Err(operation("ACP agent startup interrupted")),
            result = initialize => result.unwrap_or_else(|_| Err(operation("ACP agent startup timed out"))),
        };
        match result {
            Ok(session) => Ok((process, session)),
            Err(error) => {
                process.reap().await;
                Err(error)
            }
        }
    }
}

#[async_trait]
impl HarnessRuntime for AcpRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        Ok(HarnessCapabilities {
            provider: "acp".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: true,
            one_shot_runs: true,
            structured_inference: false,
            session_resumption: false,
            default_model: None,
            models: Vec::new(),
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: Default::default(),
            questions: Default::default(),
        })
    }

    async fn start_session(
        &self,
        mut request: StartSessionRequest,
        events: Arc<dyn EventSink>,
        controls: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        let resume = match &request.mode {
            SessionMode::New => None,
            SessionMode::Resume(id) => Some(id.as_str()),
            SessionMode::Fork(_) => {
                return Err(HarnessError::Unsupported("ACP session forking".into()));
            }
        };
        let directory = request.config.working_directory.take();
        if request.config != RequestConfig::default() {
            return Err(HarnessError::Unsupported(
                "ACP uses the agent's configured session settings".into(),
            ));
        }
        let (process, session) = self.open(directory, resume, None, None).await?;
        session::start(process, request, session, events, controls).await
    }

    async fn run_once(
        &self,
        request: RunRequest,
        events: Arc<dyn EventSink>,
        _controls: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        session::run_once(self.clone(), request, events)
    }
}

#[cfg(test)]
mod properties;
