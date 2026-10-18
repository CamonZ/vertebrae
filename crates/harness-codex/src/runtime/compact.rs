//! Manual compaction shares the root operation gate and lossless notification receiver.
use serde_json::json;
use vertebrae_harness_core::{
    CompactionEvent, CompactionState, CompletionStatus, HarnessError, HarnessEventPayloadV1,
    TurnId, UpdateSemantics,
};

use super::{outcome::TurnAccumulator, session::SessionState};
use crate::{decode_notification, optional_string};

impl SessionState {
    pub(super) async fn compact(&self) -> Result<(), HarnessError> {
        if *self.closed_rx.borrow() {
            return Err(HarnessError::Operation("Codex session is closed".into()));
        }
        let connection = self.connection_for_turn().await?;
        let mut notifications = connection.lock_notifications().await;
        let mut closed = self.closed_rx.clone();
        let mut connection_closed = connection.closed.subscribe();
        let turn_id = TurnId::new(format!("{}:compact", self.root_session_id.as_str()));
        connection.begin_root_turn(turn_id.clone());
        let result = async {
            connection.request_with_timeout(
                "thread/compact/start",
                json!({"threadId": self.root_thread_id.as_str()}),
                self.config.request_timeout,
                None,
            ).await?;
            self.emit_compaction(CompactionState::Active).await?;
            let mut provider_turn: Option<String> = None;
            let mut accumulator = TurnAccumulator::default();
            let mut compacted = false;
            loop {
                tokio::select! {
                    biased;
                    _ = closed.changed() => return Err(HarnessError::Operation("Codex session closed during compaction".into())),
                    notification = notifications.recv() => {
                        let notification = notification.ok_or_else(|| HarnessError::Operation("Codex notification stream closed".into()))?;
                        let params = &notification.params;
                        if optional_string(params, &["/threadId"]).as_deref() != Some(self.root_thread_id.as_str()) {
                            continue;
                        }
                        let actual_turn = optional_string(params, &["/turnId", "/turn/id"]);
                        if notification.method == "turn/started" {
                            if let Some(id) = actual_turn {
                                connection.bind_root_turn(&id, turn_id.clone());
                                provider_turn = Some(id);
                            }
                            continue;
                        }
                        if provider_turn.as_ref().is_some_and(|expected| actual_turn.as_ref().is_some_and(|actual| actual != expected)) {
                            continue;
                        }
                        if notification.method == "error" {
                            return Err(HarnessError::Operation(optional_string(params, &["/error/message", "/message"]).unwrap_or_else(|| "Codex compaction failed".into())));
                        }
                        if provider_turn.is_some() && actual_turn == provider_turn && notification.method == "item/completed" && params.pointer("/item/type").and_then(serde_json::Value::as_str) == Some("contextCompaction") {
                            compacted = true;
                        }
                        // Ignore transcript content: compaction is not an assistant answer.
                        if notification.method == "thread/tokenUsage/updated" || (notification.method == "turn/completed" && provider_turn.is_some()) {
                            let decoded = decode_notification(notification.method, notification.params).map_err(HarnessError::Operation)?;
                            if let Some(outcome) = self.process_notification(decoded, provider_turn.as_deref(), None, &mut accumulator).await? {
                                return if outcome.status == CompletionStatus::Completed && compacted {
                                    Ok(())
                                } else {
                                    Err(HarnessError::Operation(outcome.error.unwrap_or_else(|| "Codex compaction did not complete".into())))
                                };
                            }
                        }
                    }
                    _ = connection_closed.changed() => return Err(HarnessError::Operation("Codex connection closed during compaction".into())),
                }
            }
        }.await;
        if result.is_err() && !*self.closed_rx.borrow() {
            // Keep the provider identity bound until any outstanding work is interrupted.
            if let Some(provider_turn) = connection.root_turn_identity.active_provider_turn() {
                let _ = connection
                    .request_with_timeout(
                        "turn/interrupt",
                        json!({"threadId": self.root_thread_id.as_str(), "turnId": provider_turn}),
                        self.config.cleanup_timeout,
                        None,
                    )
                    .await;
            }
        }
        connection.finish_root_turn(&turn_id);
        self.emit_compaction(if result.is_ok() {
            CompactionState::Completed
        } else {
            CompactionState::Cleared
        })
        .await?;
        result
    }

    async fn emit_compaction(&self, state: CompactionState) -> Result<(), HarnessError> {
        self.emit(
            self.root_stream_id.clone(),
            self.root_correlation(None, None),
            HarnessEventPayloadV1::Compaction(CompactionEvent {
                state,
                trigger: Some("manual".into()),
                pre_tokens: None,
            }),
            UpdateSemantics::Snapshot,
        )
        .await
    }
}
