//! Codex App Server v2 (codex-cli 0.169.0) reports a shell command as a
//! `commandExecution` item. When the model backgrounds it, the tool call
//! returns while the process keeps running: the item is still open when the
//! turn completes, and its `item/completed` with the exit code arrives later,
//! often between turns. There is no other lifecycle for it; the experimental
//! `thread/backgroundTerminals/list` is not used.
//!
//! Subagents are not background work.

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use chrono::{DateTime, Utc};
use serde_json::Value;
use vertebrae_harness_core::{
    BackgroundWorkEvent, BackgroundWorkKind, BackgroundWorkStatus, HarnessError,
    HarnessEventPayloadV1, ToolCallId, TurnId, UpdateSemantics,
};

use super::connection::{CodexConnection, NotificationMessage};
use super::projection::summary;
use super::session::SessionState;
use crate::optional_string;

#[derive(Debug, Default)]
pub(crate) struct BackgroundCommands {
    /// Commands of the current turn that have not completed, in start order.
    open: Vec<BackgroundWorkEvent>,
    backgrounded: HashSet<String>,
}

impl BackgroundCommands {
    fn started(&mut self, item: &Value, params: &Value) {
        let Some(id) = optional_string(item, &["/id"]) else {
            return;
        };

        let mut work = BackgroundWorkEvent::new(
            id.as_str(),
            BackgroundWorkKind::Command,
            BackgroundWorkStatus::Running,
        );
        work.provider_kind = Some("commandExecution".into());
        work.description =
            optional_string(item, &["/command"]).and_then(|command| summary(&command));
        work.launch_tool_call_id = Some(ToolCallId::new(id));
        work.started_at = epoch_millis(params.get("startedAtMs"));

        self.open.push(work);
    }

    /// Commands still open when the turn ends are the backgrounded ones.
    fn turn_completed(&mut self) -> Vec<BackgroundWorkEvent> {
        let open = std::mem::take(&mut self.open);
        self.backgrounded
            .extend(open.iter().map(|work| work.work_id.to_string()));

        open
    }

    fn completed(&mut self, item: &Value, params: &Value) -> Option<BackgroundWorkEvent> {
        let id = optional_string(item, &["/id"])?;
        self.open.retain(|work| work.work_id.as_str() != id);
        if !self.backgrounded.remove(&id) {
            return None;
        }

        let (status, error) = command_outcome(item);
        let mut work = BackgroundWorkEvent::new(id.as_str(), BackgroundWorkKind::Command, status);
        work.provider_kind = Some("commandExecution".into());
        work.launch_tool_call_id = Some(ToolCallId::new(id));
        work.finished_at = epoch_millis(params.get("completedAtMs"));
        work.error = error;

        Some(work)
    }
}

fn command_outcome(item: &Value) -> (BackgroundWorkStatus, Option<String>) {
    let exit_code = item.get("exitCode").and_then(Value::as_i64);

    match (item.get("status").and_then(Value::as_str), exit_code) {
        (Some("completed"), None | Some(0)) => (BackgroundWorkStatus::Completed, None),
        (Some("completed" | "failed"), Some(code)) => (
            BackgroundWorkStatus::Failed,
            Some(format!("exit code {code}")),
        ),
        (Some("failed"), None) => (BackgroundWorkStatus::Failed, None),
        (Some("declined"), _) => (BackgroundWorkStatus::Cancelled, None),
        _ => (BackgroundWorkStatus::Unknown, None),
    }
}

fn epoch_millis(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_i64)
        .and_then(DateTime::from_timestamp_millis)
}

fn is_command(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("commandExecution")
}

impl SessionState {
    /// Runs before the turn filter, because a command's outcome usually
    /// arrives during a later turn or between turns.
    pub(super) async fn emit_background(
        &self,
        method: &str,
        params: &Value,
        root_turn: Option<&TurnId>,
    ) -> Result<(), HarnessError> {
        let thread = optional_string(params, &["/threadId", "/thread/id"]);
        if thread.as_deref() != Some(self.root_thread_id.as_str()) {
            return Ok(());
        }

        let updates = {
            let mut commands = self
                .background_commands
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let item = params.get("item").filter(|item| is_command(item));

            match (method, item) {
                ("item/started", Some(item)) => {
                    commands.started(item, params);
                    Vec::new()
                }
                ("item/completed", Some(item)) => {
                    commands.completed(item, params).into_iter().collect()
                }
                ("turn/completed", _) => commands.turn_completed(),
                _ => Vec::new(),
            }
        };

        for work in updates {
            self.emit(
                self.root_stream_id.clone(),
                self.root_correlation(root_turn.cloned(), None),
                HarnessEventPayloadV1::BackgroundWork(work),
                UpdateSemantics::Snapshot,
            )
            .await?;
        }

        Ok(())
    }

    /// Takes the notification receiver for a foreground operation, making
    /// the idle pump release it first.
    pub(super) async fn claim_notifications(
        &self,
        connection: &CodexConnection,
    ) -> tokio::sync::OwnedMutexGuard<tokio::sync::mpsc::Receiver<NotificationMessage>> {
        self.foreground_claims.send_modify(|claims| *claims += 1);
        let guard = connection.lock_notifications().await;
        self.foreground_claims.send_modify(|claims| *claims -= 1);

        guard
    }
}

/// Reads notifications while no foreground operation holds the receiver, so
/// a background command's outcome still arrives after the reply. It holds only a weak
/// session reference and stops when the session closes.
pub(super) fn spawn_idle_pump(state: &Arc<SessionState>) {
    let weak: Weak<SessionState> = Arc::downgrade(state);
    let mut closed = state.closed_rx.clone();
    let mut claims = state.foreground_claims.subscribe();
    let mut connection_generation = state.connection_generation.subscribe();

    tokio::spawn(async move {
        loop {
            if *closed.borrow() {
                break;
            }

            tokio::select! {
                result = claims.wait_for(|claims| *claims == 0) => if result.is_err() { break },
                _ = closed.changed() => break,
            }

            let Some(connection) = weak.upgrade().map(|state| state.connection()) else {
                break;
            };
            let seen_generation = *connection_generation.borrow_and_update();

            let mut receiver = tokio::select! {
                guard = connection.lock_notifications() => guard,
                _ = closed.changed() => break,
            };

            let message = tokio::select! {
                biased;
                _ = closed.changed() => break,
                _ = claims.wait_for(|claims| *claims > 0) => continue,
                message = receiver.recv() => message,
            };

            let Some(message) = message else {
                // The connection ended, so wait for a reconnect or close.
                drop(receiver);
                tokio::select! {
                    _ = connection_generation.wait_for(|generation| *generation != seen_generation) => {}
                    _ = closed.changed() => break,
                }
                continue;
            };

            let Some(state) = weak.upgrade() else {
                break;
            };

            if let Err(error) = state
                .emit_background(&message.method, &message.params, None)
                .await
            {
                log::warn!("[Codex] idle background notification failed: {error}");
            }
            drop(receiver);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(id: &str, status: &str, exit_code: Option<i64>) -> Value {
        json!({"type": "commandExecution", "id": id, "command": "npm run dev", "status": status, "exitCode": exit_code})
    }

    #[test]
    fn only_commands_open_at_turn_end_are_background_work() {
        let mut commands = BackgroundCommands::default();
        let params = json!({"startedAtMs": 1_800_000_000_000_i64});

        commands.started(&command("fg", "inProgress", None), &params);
        commands.started(&command("bg", "inProgress", None), &params);

        assert_eq!(
            commands.completed(&command("fg", "completed", Some(0)), &json!({})),
            None
        );

        let backgrounded = commands.turn_completed();

        assert_eq!(backgrounded.len(), 1);
        assert_eq!(backgrounded[0].work_id.as_str(), "bg");
        assert_eq!(backgrounded[0].description.as_deref(), Some("npm run dev"));
        assert!(backgrounded[0].started_at.is_some());

        let outcome = commands
            .completed(&command("bg", "completed", Some(0)), &json!({}))
            .unwrap();

        assert_eq!(outcome.status, BackgroundWorkStatus::Completed);
        assert_eq!(
            commands.completed(&command("bg", "completed", Some(0)), &json!({})),
            None
        );
    }

    #[test]
    fn exit_code_decides_the_outcome() {
        let cases = [
            ("completed", Some(0), BackgroundWorkStatus::Completed, None),
            (
                "completed",
                Some(2),
                BackgroundWorkStatus::Failed,
                Some("exit code 2"),
            ),
            (
                "failed",
                Some(1),
                BackgroundWorkStatus::Failed,
                Some("exit code 1"),
            ),
            ("failed", None, BackgroundWorkStatus::Failed, None),
            ("declined", None, BackgroundWorkStatus::Cancelled, None),
            ("inProgress", None, BackgroundWorkStatus::Unknown, None),
        ];

        for (status, exit_code, expected, error) in cases {
            let (outcome, message) = command_outcome(&command("c", status, exit_code));

            assert_eq!(outcome, expected, "{status} {exit_code:?}");
            assert_eq!(message.as_deref(), error);
        }
    }
}
