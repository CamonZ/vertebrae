use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot, watch};
use vertebrae_harness_core::{
    HarnessError, RunHandle, RunId, RunOutcome, SendTurnRequest, SessionCloseOutcome,
    SessionHandle, SessionId, TurnHandle, TurnId, TurnOutcome,
};

use super::SessionCommand;

#[derive(Debug, Clone, Default)]
pub(super) enum OutcomeState<T> {
    #[default]
    Pending,
    Ready(T),
    Failed(String),
    EventSinkFailed(String),
    /// The process could not open the conversation it was asked to resume.
    SessionNotFound(String),
}

pub(super) struct ClaudeTurnHandle {
    pub(super) turn_id: TurnId,
    pub(super) command_tx: mpsc::UnboundedSender<SessionCommand>,
    pub(super) outcome_rx: watch::Receiver<OutcomeState<TurnOutcome>>,
}

pub(super) struct ClaudeSessionHandle {
    pub(super) session_id: SessionId,
    pub(super) provider_resume_id: Option<vertebrae_harness_core::ProviderResumeId>,
    /// The `--json-schema` the process was launched with. A turn may restate
    /// it; any other per-turn schema needs a new process.
    pub(super) process_output_schema: Option<serde_json::Value>,
    pub(super) command_tx: mpsc::UnboundedSender<SessionCommand>,
    pub(super) close_rx: watch::Receiver<OutcomeState<SessionCloseOutcome>>,
}

impl ClaudeSessionHandle {
    /// Why the session can no longer accept commands, preferring the
    /// process's recorded close reason (for example an unknown resume id).
    fn not_running_error(&self) -> HarnessError {
        match &*self.close_rx.borrow() {
            OutcomeState::SessionNotFound(error) => HarnessError::SessionNotFound(error.clone()),
            OutcomeState::Ready(SessionCloseOutcome {
                error: Some(error), ..
            }) => HarnessError::Operation(error.clone()),
            _ => HarnessError::Operation("Claude session process is no longer running".into()),
        }
    }

    fn session_not_found(&self) -> Option<HarnessError> {
        match &*self.close_rx.borrow() {
            OutcomeState::SessionNotFound(error) => {
                Some(HarnessError::SessionNotFound(error.clone()))
            }
            _ => None,
        }
    }
}

pub(super) struct ClaudeRunHandle {
    pub(super) run_id: RunId,
    pub(super) cancel_tx: mpsc::UnboundedSender<()>,
    pub(super) outcome_rx: watch::Receiver<OutcomeState<RunOutcome>>,
}

#[async_trait]
impl TurnHandle for ClaudeTurnHandle {
    fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }

    async fn interrupt(&self) -> Result<(), HarnessError> {
        let (response, receiver) = oneshot::channel();
        self.command_tx
            .send(SessionCommand::Interrupt {
                turn_id: self.turn_id.clone(),
                response,
            })
            .map_err(|_| {
                HarnessError::Operation("Claude session process is no longer running".into())
            })?;
        receiver
            .await
            .map_err(|_| HarnessError::Operation("Claude interrupt response was dropped".into()))?
            .map_err(HarnessError::Operation)
    }

    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        await_state(self.outcome_rx.clone()).await
    }
}

#[async_trait]
impl SessionHandle for ClaudeSessionHandle {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn provider_resume_id(&self) -> Option<&vertebrae_harness_core::ProviderResumeId> {
        self.provider_resume_id.as_ref()
    }

    async fn send(
        &self,
        mut request: SendTurnRequest,
    ) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if request.output_schema.is_some() && request.output_schema == self.process_output_schema {
            request.output_schema = None;
        }
        let (outcome_tx, outcome_rx) = watch::channel(OutcomeState::Pending);
        let (response, receiver) = oneshot::channel();
        let turn_id = request.turn_id.clone();
        self.command_tx
            .send(SessionCommand::Send {
                request,
                outcome_tx,
                response,
            })
            .map_err(|_| self.not_running_error())?;
        // The process task drops unprocessed commands only after recording
        // its close outcome.
        receiver
            .await
            .map_err(|_| self.not_running_error())?
            .map_err(|error| {
                self.session_not_found()
                    .unwrap_or(HarnessError::Operation(error))
            })?;
        Ok(Arc::new(ClaudeTurnHandle {
            turn_id,
            command_tx: self.command_tx.clone(),
            outcome_rx,
        }))
    }

    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        if let Some(error) = self.session_not_found() {
            return Err(error);
        }
        if let OutcomeState::Ready(outcome) = self.close_rx.borrow().clone() {
            return Ok(outcome);
        }
        let (response, receiver) = oneshot::channel();
        if self
            .command_tx
            .send(SessionCommand::Close { response })
            .is_ok()
            && let Ok(result) = receiver.await
        {
            // The process records its close state before answering.
            if let Some(error) = self.session_not_found() {
                return Err(error);
            }
            return result.map_err(HarnessError::Operation);
        }
        await_state(self.close_rx.clone()).await
    }
}

#[async_trait]
impl RunHandle for ClaudeRunHandle {
    fn run_id(&self) -> &RunId {
        &self.run_id
    }

    async fn cancel(&self) -> Result<(), HarnessError> {
        self.cancel_tx
            .send(())
            .map_err(|_| HarnessError::Operation("Claude run is no longer running".into()))
    }

    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        await_state(self.outcome_rx.clone()).await
    }
}

async fn await_state<T: Clone>(
    mut receiver: watch::Receiver<OutcomeState<T>>,
) -> Result<T, HarnessError> {
    loop {
        let state = receiver.borrow().clone();
        match state {
            OutcomeState::Pending => receiver.changed().await.map_err(|_| {
                HarnessError::Operation("Claude operation ended without an outcome".into())
            })?,
            OutcomeState::Ready(value) => return Ok(value),
            OutcomeState::Failed(error) => return Err(HarnessError::Operation(error)),
            OutcomeState::EventSinkFailed(error) => return Err(HarnessError::EventSink(error)),
            OutcomeState::SessionNotFound(error) => {
                return Err(HarnessError::SessionNotFound(error));
            }
        }
    }
}
