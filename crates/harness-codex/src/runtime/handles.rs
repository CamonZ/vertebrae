use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::watch;
use vertebrae_harness_core::{
    CompletionStatus, HarnessError, ProviderResumeId, RunHandle, RunId, RunOutcome,
    SendTurnRequest, SessionCloseOutcome, SessionCloseStatus, SessionHandle, SessionId, TurnHandle,
    TurnId, TurnInputProvenance, TurnOutcome,
};

use super::outcome::cancelled_outcome;
use super::session::SessionState;
pub(crate) struct CodexSessionHandle {
    pub(super) state: Arc<SessionState>,
    pub(super) session_id: SessionId,
    pub(super) provider_resume_id: ProviderResumeId,
}
pub(crate) struct CodexTurnHandle {
    pub(super) turn_id: TurnId,
    pub(super) cancel: watch::Sender<bool>,
    pub(super) outcome: watch::Receiver<OutcomeState<TurnOutcome>>,
}
pub(crate) struct CodexRunHandle {
    pub(super) run_id: RunId,
    pub(super) cancel: watch::Sender<bool>,
    pub(super) outcome: watch::Receiver<OutcomeState<RunOutcome>>,
}

#[derive(Clone, Default)]
pub(crate) enum OutcomeState<T> {
    #[default]
    Pending,
    Ready(T),
    Failed(OutcomeFailure),
}

#[derive(Clone)]
pub(super) enum OutcomeFailure {
    EventSink(String),
    Other(String),
}

impl From<HarnessError> for OutcomeFailure {
    fn from(error: HarnessError) -> Self {
        match error {
            HarnessError::EventSink(message) => Self::EventSink(message),
            error => Self::Other(error.to_string()),
        }
    }
}

impl OutcomeFailure {
    fn into_harness_error(self) -> HarnessError {
        match self {
            Self::EventSink(message) => HarnessError::EventSink(message),
            Self::Other(message) => HarnessError::Operation(message),
        }
    }
}

#[async_trait]
impl SessionHandle for CodexSessionHandle {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }
    fn provider_resume_id(&self) -> Option<&ProviderResumeId> {
        Some(&self.provider_resume_id)
    }
    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if *self.state.closed_rx.borrow() {
            return Err(HarnessError::Operation(
                "cannot send a turn on a closed Codex session".into(),
            ));
        }
        let (tx, rx) = watch::channel(OutcomeState::Pending);
        let (cancel, cancel_rx) = watch::channel(false);
        let state = Arc::clone(&self.state);
        let turn_id = request.turn_id.clone();
        let turn_id_for_task = turn_id.clone();
        let task_state = Arc::clone(&state);
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let result = if *task_state.closed_rx.borrow() {
                Ok(cancelled_outcome(CompletionStatus::Interrupted, None))
            } else {
                task_state
                    .execute_turn(
                        turn_id_for_task,
                        request.content,
                        request.output_schema,
                        None,
                        TurnInputProvenance::Human,
                        cancel_rx,
                    )
                    .await
            };
            let _ = tx.send(match result {
                Ok(value) => OutcomeState::Ready(value),
                Err(error) => OutcomeState::Failed(error.into()),
            });
        });
        Ok(Arc::new(CodexTurnHandle {
            turn_id,
            cancel,
            outcome: rx,
        }))
    }
    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        self.state.close(SessionCloseStatus::Closed, None).await
    }
}

#[async_trait]
impl TurnHandle for CodexTurnHandle {
    fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }
    async fn interrupt(&self) -> Result<(), HarnessError> {
        let _ = self.cancel.send(true);
        Ok(())
    }
    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        await_state(self.outcome.clone(), "Codex turn ended without an outcome").await
    }
}

#[async_trait]
impl RunHandle for CodexRunHandle {
    fn run_id(&self) -> &RunId {
        &self.run_id
    }
    async fn cancel(&self) -> Result<(), HarnessError> {
        let _ = self.cancel.send(true);
        Ok(())
    }
    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        await_state(self.outcome.clone(), "Codex run ended without an outcome").await
    }
}

pub(crate) async fn await_state<T: Clone>(
    mut receiver: watch::Receiver<OutcomeState<T>>,
    message: &str,
) -> Result<T, HarnessError> {
    loop {
        let state = receiver.borrow().clone();
        match state {
            OutcomeState::Pending => receiver
                .changed()
                .await
                .map_err(|_| HarnessError::Operation(message.into()))?,
            OutcomeState::Ready(value) => return Ok(value),
            OutcomeState::Failed(error) => return Err(error.into_harness_error()),
        }
    }
}
