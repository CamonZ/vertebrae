//! ACP v1 interactive sessions over newline-delimited JSON-RPC.
mod config;
mod protocol;
mod session;
mod updates;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::json;
use tokio::time::timeout;
use vertebrae_harness_core::{
    ControlSink, EventSink, HarnessCapabilities, HarnessError, HarnessRuntime, RequestConfig,
    RunHandle, RunRequest, SessionHandle, SessionMode, StartSessionRequest,
};

pub use config::{Discovery, SessionConfig};
use protocol::{Process, operation};

struct AgentSession {
    id: String,
    config: SessionConfig,
    supports_steering: bool,
    supports_resume: bool,
}

#[derive(PartialEq, Eq)]
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

        let (mut process, session) = self.open(Some(directory.path().into()), None).await?;
        let AgentSession {
            id,
            config,
            supports_steering,
            supports_resume,
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

    async fn open(
        &self,
        directory: Option<PathBuf>,
        resume: Option<&str>,
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
        let result = timeout(Duration::from_secs(30), async {
            let initialized = process.request(1, "initialize", json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name":"vertebrae", "title":"Vertebrae", "version":env!("CARGO_PKG_VERSION")}
            })).await?;
            if initialized["protocolVersion"] != 1 {
                return Err(HarnessError::Unsupported("ACP agent did not negotiate protocol version 1".into()));
            }
            let supports_resume = initialized.pointer("/agentCapabilities/sessionCapabilities/resume")
                .is_some_and(serde_json::Value::is_object);
            let session = match resume {
                Some(id) if supports_resume => process.request(2, "session/resume",
                    json!({"cwd":cwd, "sessionId":id, "mcpServers":[]})).await?,
                Some(_) => return Err(HarnessError::Unsupported("ACP session restoration".into())),
                None => process.request(2, "session/new", json!({"cwd":cwd, "mcpServers":[]})).await?,
            };
            let id = session["sessionId"].as_str().or(resume).filter(|id| !id.is_empty()).map(str::to_owned)
                .ok_or_else(|| operation("ACP agent returned no session ID"))?;
            if resume.is_some_and(|resume| resume != id) {
                return Err(operation("ACP agent returned a different session ID on resume"));
            }
            let mut config = SessionConfig::default();
            config.replace(&session);
            Ok(AgentSession {
                id,
                config,
                supports_steering: config::supports_steering(&initialized),
                supports_resume,
            })
        }).await.unwrap_or_else(|_| Err(operation("ACP agent startup timed out")));
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
            one_shot_runs: false,
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
        let (process, session) = self.open(directory, resume).await?;
        session::start(process, request, session, events, controls).await
    }

    async fn run_once(
        &self,
        _request: RunRequest,
        _events: Arc<dyn EventSink>,
        _controls: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        Err(HarnessError::Unsupported("ACP workflow execution".into()))
    }
}

#[cfg(test)]
mod properties;
