use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot, watch};
use vertebrae_harness_core::{
    HarnessCapabilities, HarnessError, HarnessRuntime, ModelCapability, PermissionModeCapability,
    ProviderResumeId, QuestionCapabilities, RunHandle, RunRequest, SendTurnRequest,
    SessionCloseOutcome, SessionHandle, SessionId, SpeedTier, StartSessionRequest, TurnId,
    TurnOutcome,
};

use crate::{
    ClaudeDecodeContext, ClaudeLaunchMode, ClaudeProviderConfig, DEFAULT_CLAUDE_MODELS,
    config::claude_model_supports_fast_mode,
};

mod controls;
mod events;
mod handles;
mod process;
mod run;
mod session;

use handles::{ClaudeRunHandle, ClaudeSessionHandle, OutcomeState};
use process::spawn_process;
use run::run_one_shot_process_v2;
use session::run_persistent_process_v2;

#[derive(Clone)]
pub struct ClaudeRuntime {
    config: Arc<ClaudeProviderConfig>,
}

impl ClaudeRuntime {
    pub fn new(config: ClaudeProviderConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    pub fn config(&self) -> &ClaudeProviderConfig {
        &self.config
    }
}

fn claude_permission_modes() -> Vec<PermissionModeCapability> {
    [
        ("default", "Ask before edits", true),
        ("accept_edits", "Edit automatically", false),
        ("plan", "Plan mode", false),
        ("auto", "Auto mode", false),
        ("dont_ask", "Don't ask", false),
        ("bypass_permissions", "Bypass permissions", false),
    ]
    .into_iter()
    .map(|(id, label, is_default)| PermissionModeCapability {
        id: id.into(),
        label: label.into(),
        is_default,
    })
    .collect()
}

fn claude_model_speed_tiers(model: &str) -> BTreeSet<SpeedTier> {
    if claude_model_supports_fast_mode(model) {
        BTreeSet::from([SpeedTier::Default, SpeedTier::Fast])
    } else {
        BTreeSet::new()
    }
}

enum SessionCommand {
    Send {
        request: SendTurnRequest,
        outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
        response: oneshot::Sender<Result<(), String>>,
    },
    Interrupt {
        turn_id: TurnId,
        response: oneshot::Sender<Result<(), String>>,
    },
    Close {
        response: oneshot::Sender<Result<SessionCloseOutcome, String>>,
    },
}

struct PendingTurn {
    id: TurnId,
    content: String,
    input_emitted: bool,
    response: Option<oneshot::Sender<Result<(), String>>>,
    outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
}

#[async_trait]
impl HarnessRuntime for ClaudeRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        match self.config.resolve_executable() {
            Ok(_) => Ok(HarnessCapabilities {
                provider: "anthropic".into(),
                available: true,
                unavailable_reason: None,
                persistent_sessions: true,
                one_shot_runs: true,
                session_resumption: true,
                default_model: Some("sonnet".into()),
                models: DEFAULT_CLAUDE_MODELS
                    .iter()
                    .map(|(id, label)| ModelCapability {
                        id: (*id).into(),
                        label: (*label).into(),
                        reasoning_efforts: BTreeSet::new(),
                        supported_speed_tiers: claude_model_speed_tiers(id),
                        supports_personality: None,
                    })
                    .collect(),
                default_permission_mode: Some("default".into()),
                permission_modes: claude_permission_modes(),
                approval_categories: BTreeSet::new(),
                questions: QuestionCapabilities {
                    multiple_selection: true,
                    free_form_answers: true,
                    automatic_resolution: true,
                },
            }),
            Err(error) => Ok(HarnessCapabilities {
                provider: "anthropic".into(),
                available: false,
                unavailable_reason: Some(error.to_string()),
                persistent_sessions: true,
                one_shot_runs: true,
                session_resumption: true,
                default_model: Some("sonnet".into()),
                models: Vec::new(),
                default_permission_mode: Some("default".into()),
                permission_modes: claude_permission_modes(),
                approval_categories: BTreeSet::new(),
                questions: QuestionCapabilities::default(),
            }),
        }
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn vertebrae_harness_core::EventSink>,
        control_sink: Arc<dyn vertebrae_harness_core::ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        let spec = self.config.command_spec(
            ClaudeLaunchMode::Persistent {
                resume_id: request.resume_id.as_ref().map(ProviderResumeId::as_str),
            },
            &request.config,
        )?;
        let mut child = spawn_process(&spec, true).await?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdout".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stderr".into())
        })?;
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let (close_tx, close_rx) = watch::channel(OutcomeState::Pending);
        let context = ClaudeDecodeContext {
            // A newly created Claude session has no provider conversation id
            // until the first input causes Claude to emit system/init. A
            // resumed session can safely send its known provider id.
            session_id: request
                .resume_id
                .as_ref()
                .map(|resume_id| SessionId::new(resume_id.as_str())),
            root_thread_id: vertebrae_harness_core::ThreadId::new(request.session_id.as_str()),
            root_stream_id: request.stream_id,
            turn_id: None,
            run_id: None,
            provider_resume_id: request.resume_id.clone(),
            requested_speed_tier: request.config.speed_tier,
        };
        let cleanup_timeout = self.config.cleanup_timeout;
        let initialization_timeout = self.config.initialization_timeout;
        let root_locator_resolver = self.config.root_locator_resolver.clone();
        tokio::spawn(run_persistent_process_v2(
            child,
            stdin,
            stdout,
            stderr,
            command_rx,
            close_tx,
            context,
            event_sink,
            control_sink,
            cleanup_timeout,
            initialization_timeout,
            root_locator_resolver,
        ));
        Ok(Arc::new(ClaudeSessionHandle {
            // Claude Code emits its canonical system/init record only after
            // the first stream-json user message. The authoritative provider
            // identity arrives through SessionStarted; these request values
            // keep the handle usable while that first turn is in flight.
            session_id: request.session_id,
            provider_resume_id: request.resume_id,
            command_tx,
            close_rx,
        }))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn vertebrae_harness_core::EventSink>,
        control_sink: Arc<dyn vertebrae_harness_core::ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let spec = self.config.command_spec(
            ClaudeLaunchMode::OneShot {
                prompt: &request.prompt,
            },
            &request.config,
        )?;
        let mut child = spawn_process(&spec, true).await?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdout".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stderr".into())
        })?;
        let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
        let (outcome_tx, outcome_rx) = watch::channel(OutcomeState::Pending);
        let mut context = ClaudeDecodeContext::one_shot(request.run_id.clone(), request.stream_id);
        context.requested_speed_tier = request.config.speed_tier;
        let cleanup_timeout = self.config.cleanup_timeout;
        let terminal_exit_timeout = self.config.terminal_exit_timeout;
        let root_locator_resolver = self.config.root_locator_resolver.clone();
        tokio::spawn(run_one_shot_process_v2(
            child,
            stdin,
            stdout,
            stderr,
            cancel_rx,
            outcome_tx,
            context,
            request.prompt,
            event_sink,
            control_sink,
            cleanup_timeout,
            terminal_exit_timeout,
            root_locator_resolver,
        ));
        Ok(Arc::new(ClaudeRunHandle {
            run_id: request.run_id,
            cancel_tx,
            outcome_rx,
        }))
    }
}
