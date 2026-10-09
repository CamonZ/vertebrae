mod connection;
mod control;
mod handles;
mod outcome;
mod projection;
mod session;
mod setup;
mod subscription;
mod trace;
mod turn;

pub(crate) use setup::attach;
pub(crate) use subscription::OwnedThreads;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::watch;
use vertebrae_harness_core::{HarnessEventPayloadV1, ProviderResumeId, UpdateSemantics};

use crate::CodexProviderConfig;
use vertebrae_harness_core::{
    ApprovalCategory, CompletionStatus, ControlSink, EventSink, HarnessCapabilities, HarnessError,
    HarnessRuntime, OutcomeMetrics, QuestionCapabilities, RunHandle, RunOutcome, RunRequest,
    SessionCloseStatus, SessionHandle, StartSessionRequest, TurnId, TurnInputProvenance,
};

use handles::{CodexRunHandle, CodexSessionHandle, OutcomeState};
use outcome::cancelled_outcome;
use setup::setup_session;

#[derive(Clone)]
pub struct CodexRuntime {
    config: Arc<CodexProviderConfig>,
}

impl CodexRuntime {
    pub fn new(config: CodexProviderConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
    pub fn config(&self) -> &CodexProviderConfig {
        &self.config
    }
}

#[async_trait]
impl HarnessRuntime for CodexRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        match self.config.discover_capabilities().await {
            Ok(capabilities) => Ok(capabilities),
            Err(error) => Ok(HarnessCapabilities {
                provider: "openai".into(),
                available: false,
                unavailable_reason: Some(error.to_string()),
                persistent_sessions: true,
                one_shot_runs: true,
                structured_inference: false,
                session_resumption: true,
                default_model: None,
                models: Vec::new(),
                default_permission_mode: None,
                permission_modes: Vec::new(),
                approval_categories: [
                    ApprovalCategory::CommandExecution,
                    ApprovalCategory::FileChange,
                    ApprovalCategory::AdditionalPermission,
                ]
                .into_iter()
                .collect(),
                questions: QuestionCapabilities {
                    multiple_selection: true,
                    free_form_answers: true,
                    automatic_resolution: true,
                },
            }),
        }
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        let state = setup_session(
            Arc::clone(&self.config),
            request.stream_id,
            request.config,
            request.resume_id,
            event_sink,
            control_sink,
        )
        .await?;
        let handle = CodexSessionHandle {
            session_id: state.root_session_id.clone(),
            provider_resume_id: ProviderResumeId::new(state.root_thread_id.as_str()),
            state,
        };
        Ok(Arc::new(handle))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let state = setup_session(
            Arc::clone(&self.config),
            request.stream_id,
            request.config,
            None,
            event_sink,
            control_sink,
        )
        .await?;
        let (tx, rx) = watch::channel(OutcomeState::Pending);
        let (cancel, cancel_rx) = watch::channel(false);
        let run_id = request.run_id.clone();
        let task_run_id = run_id.clone();
        let task_state = Arc::clone(&state);
        let turn_key = format!("{}:turn", task_run_id);
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let outcome = if *task_state.closed_rx.borrow() {
                Ok(cancelled_outcome(CompletionStatus::Cancelled, None))
            } else {
                task_state
                    .execute_turn(
                        TurnId::new(turn_key.clone()),
                        request.prompt,
                        task_state.default_output_schema.clone(),
                        Some(task_run_id.clone()),
                        TurnInputProvenance::Human,
                        cancel_rx,
                    )
                    .await
            };
            let run = match outcome {
                Ok(outcome) => RunOutcome {
                    status: outcome.status,
                    result_text: outcome.result_text,
                    structured_output: outcome.structured_output,
                    usage: outcome.usage,
                    metrics: outcome.metrics,
                    error: outcome.error,
                },
                Err(error) => RunOutcome {
                    status: CompletionStatus::Failed,
                    result_text: None,
                    structured_output: None,
                    usage: None,
                    metrics: OutcomeMetrics::default(),
                    error: Some(error.to_string()),
                },
            };
            let _ = task_state
                .emit(
                    task_state.root_stream_id.clone(),
                    task_state.root_correlation(None, Some(task_run_id.clone())),
                    HarnessEventPayloadV1::RunFinished(run.clone()),
                    UpdateSemantics::Snapshot,
                )
                .await;
            let _ = task_state.close(SessionCloseStatus::Closed, None).await;
            let _ = tx.send(OutcomeState::Ready(run));
        });
        Ok(Arc::new(CodexRunHandle {
            run_id,
            cancel,
            outcome: rx,
        }))
    }
}
