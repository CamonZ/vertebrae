use tokio::process::Child;
use tokio::sync::Mutex;

use crate::local_chat::{
    LocalChatEvent, LocalChatEventSink, LocalChatHarnessKind, LocalChatSessionError,
    LocalChatSessionErrorEvent,
};

use super::permissions::CodexPermissionSettings;
use super::rpc::{CodexRpcConnection, TurnRequest};

pub(super) struct CodexLocalChatSession {
    pub(super) backend_session_id: String,
    pub(super) thread_id: String,
    pub(super) event_sink: LocalChatEventSink,
    pub(super) connection: CodexRpcConnection,
    pub(super) process: Mutex<Option<Child>>,
    pub(super) stats: Mutex<SessionStats>,
    pub(super) permission_settings: CodexPermissionSettings,
    pub(super) turn_lock: Mutex<()>,
}

impl CodexLocalChatSession {
    pub(super) async fn run_turn(
        &self,
        content: &str,
        failure_surface: TurnFailureSurface,
    ) -> Result<(), LocalChatSessionError> {
        let _turn_lock = self.turn_lock.lock().await;
        let num_turns = {
            let stats = self.stats.lock().await;
            stats.num_turns.saturating_add(1)
        };
        let outcome = match self
            .connection
            .start_turn(TurnRequest {
                thread_id: &self.thread_id,
                content,
                num_turns,
                permission_settings: self.permission_settings,
            })
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                log::error!(
                    "[Codex local chat] turn RPC failed for {}: {}",
                    self.backend_session_id,
                    error
                );
                self.emit_error(error.clone());
                return Err(failure_surface.error(error));
            }
        };

        let mut stats = self.stats.lock().await;
        stats.num_turns = stats.num_turns.saturating_add(1);
        stats.context_tokens = outcome.context_tokens;
        stats.context_window = outcome.context_window;

        if let Some(error) = outcome.error {
            Err(failure_surface.error(error))
        } else {
            Ok(())
        }
    }

    pub(super) async fn shutdown(&self) {
        let _ = self.connection.close().await;

        let mut process = self.process.lock().await;
        stop_process(&mut process).await;
    }

    fn emit_error(&self, error: String) {
        self.event_sink
            .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                error,
            }));
    }
}

pub(super) async fn stop_process(process: &mut Option<Child>) {
    if let Some(child) = process.as_mut() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    *process = None;
}

#[derive(Default)]
pub(super) struct SessionStats {
    pub(super) num_turns: u32,
    pub(super) context_tokens: u32,
    pub(super) context_window: u32,
}

#[derive(Clone, Copy)]
pub(super) enum TurnFailureSurface {
    Start,
    Send,
}

impl TurnFailureSurface {
    fn error(self, message: String) -> LocalChatSessionError {
        match self {
            TurnFailureSurface::Start => LocalChatSessionError::StartFailed(message),
            TurnFailureSurface::Send => LocalChatSessionError::SendFailed(message),
        }
    }
}
