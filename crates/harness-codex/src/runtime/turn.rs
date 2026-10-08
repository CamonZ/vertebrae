use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use vertebrae_harness_core::{
    CompletionStatus, HarnessError, HarnessEventPayloadV1, RunId, TurnId, TurnInput,
    TurnInputProvenance, TurnOutcome, TurnStarted, UpdateSemantics,
};

use super::connection::{NotificationMessage, is_draining};
use super::outcome::{
    TurnAccumulator, cancelled_outcome, failed_outcome, validate_structured_output,
};
use super::projection::summary;
use super::session::{RecoveredTurn, SessionState};
use super::trace::trace;
use crate::{decode_notification, required_string};

impl SessionState {
    pub(super) async fn execute_turn(
        &self,
        turn_id: TurnId,
        content: String,
        output_schema: Option<Value>,
        run_id: Option<RunId>,
        provenance: TurnInputProvenance,
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<TurnOutcome, HarnessError> {
        let content_len = content.len();
        trace(
            Some(self.root_session_id.as_str()),
            "turn.requested",
            "internal",
            Some(turn_id.as_str()),
            "starting",
            Some(&format!("content_len={content_len}")),
            Some(&content),
        );
        let mut session_closed = self.closed_rx.clone();
        let correlation = self.root_correlation(Some(turn_id.clone()), run_id.clone());
        self.emit(
            self.root_stream_id.clone(),
            correlation.clone(),
            HarnessEventPayloadV1::TurnStarted(TurnStarted {
                input_summary: summary(&content),
            }),
            UpdateSemantics::Snapshot,
        )
        .await?;
        let validation_schema = output_schema.clone();
        let result = async {
            self.emit(
                self.root_stream_id.clone(),
                correlation,
                HarnessEventPayloadV1::TurnInput(TurnInput {
                    thread_id: self.root_thread_id.clone(),
                    run_id: run_id.clone(),
                    content: content.clone(),
                    provenance,
                }),
                UpdateSemantics::Snapshot,
            )
            .await?;
            if *cancel_rx.borrow() {
                return Ok(cancelled_outcome(CompletionStatus::Cancelled, None));
            }

            let mut params = json!({"threadId": self.root_thread_id.as_str(), "input": [{"type":"text", "text": content}]});
            if let Some(schema) = output_schema {
                params["outputSchema"] = schema;
            }
            self.config.permission.apply_to_params(&mut params);
            let mut connection = self.connection_for_turn().await?;
            let mut retried_drain = false;
            let (response, mut notifications, mut connection_closed) = loop {
                // There is one lossless receiver per connection. Holding it
                // for the duration of a root turn also makes the single
                // root-turn gate explicit: every notification is consumed
                // exactly once, while the websocket reader applies
                // backpressure to the provider instead of dropping messages
                // from a broadcast ring.
                let notifications = connection.lock_notifications().await;
                let connection_closed = connection.closed.subscribe();
                connection.begin_root_turn(turn_id.clone());
                let response = connection
                    .request_with_timeout(
                        "turn/start",
                        params.clone(),
                        self.config.request_timeout,
                        Some(turn_id.clone()),
                    )
                    .await;
                match response {
                    Err(error) if is_draining(&error) && !retried_drain => {
                        retried_drain = true;
                        connection.finish_root_turn(&turn_id);
                        drop(notifications);
                        connection.close().await;
                        connection = self.reconnect().await?;
                    }
                    response => break (response, notifications, connection_closed),
                }
            };
            let response = match response {
                Ok(response) => response,
                Err(_error) if *session_closed.borrow() => {
                    return Ok(cancelled_outcome(
                        if run_id.is_none() {
                            CompletionStatus::Interrupted
                        } else {
                            CompletionStatus::Cancelled
                        },
                        None,
                    ));
                }
                Err(error) => return Err(error),
            };
            let provider_turn = required_string(
                response.get("turn").unwrap_or(&response),
                &["/id", "/turn/id"],
                "turn/start response turn id",
            )
            .map_err(HarnessError::Operation)?;
            log::info!(
                "[Codex] turn/start accepted requested_turn_id={} provider_turn_id={provider_turn}",
                turn_id
            );
            trace(
                Some(self.root_session_id.as_str()),
                "turn.accepted",
                "provider_to_harness",
                Some(turn_id.as_str()),
                "awaiting_provider",
                Some(&format!("provider_turn_id={provider_turn}")),
                None,
            );
            let mut accumulator = TurnAccumulator::default();
            let outcome = loop {
                if *session_closed.borrow() {
                    break cancelled_outcome(
                        if run_id.is_none() {
                            CompletionStatus::Interrupted
                        } else {
                            CompletionStatus::Cancelled
                        },
                        accumulator.usage,
                    );
                }
                tokio::select! {
                    changed = session_closed.changed() => {
                        if changed.is_ok() && *session_closed.borrow() {
                            break cancelled_outcome(
                                if run_id.is_none() {
                                    CompletionStatus::Interrupted
                                } else {
                                    CompletionStatus::Cancelled
                                },
                                accumulator.usage,
                            );
                        }
                    }
                    changed = cancel_rx.changed() => {
                        if changed.is_ok() && *cancel_rx.borrow() {
                            let provider_terminal = tokio::time::timeout(
                                self.config.terminal_exit_timeout,
                                async {
                                    tokio::select! {
                                        outcome = self.wait_for_provider_terminal(
                                            &provider_turn,
                                            &turn_id,
                                            &mut notifications,
                                            &mut connection_closed,
                                            &mut accumulator,
                                        ) => outcome,
                                        _ = connection.request_no_wait(
                                            "turn/interrupt",
                                            json!({"threadId": self.root_thread_id.as_str(), "turnId": provider_turn}),
                                        ) => self.wait_for_provider_terminal(
                                            &provider_turn,
                                            &turn_id,
                                            &mut notifications,
                                            &mut connection_closed,
                                            &mut accumulator,
                                        ).await,
                                    }
                                },
                            )
                            .await;
                            break match provider_terminal {
                                Ok(result) => result?,
                                Err(_) => cancelled_outcome(
                                    if run_id.is_none() {
                                        CompletionStatus::Interrupted
                                    } else {
                                        CompletionStatus::Cancelled
                                    },
                                    accumulator.usage,
                                ),
                            };
                        }
                    }
                    outcome = self.next_provider_notification(
                        &provider_turn,
                        &turn_id,
                        &mut notifications,
                        &mut connection_closed,
                        &mut accumulator,
                    ) => {
                        match outcome {
                            Ok(Some(outcome)) => break outcome,
                            Ok(None) => {}
                            Err(error) if connection.is_closed() && !*session_closed.borrow() => {
                                let lost = connection
                                    .closed
                                    .borrow()
                                    .clone()
                                    .unwrap_or_else(|| error.to_string());
                                match self
                                    .recover_turn(&provider_turn, &turn_id, &mut accumulator)
                                    .await
                                    .map_err(|recovery| {
                                        HarnessError::Operation(format!(
                                            "{lost}; reconciling the turn after reattaching failed: {recovery}"
                                        ))
                                    })?
                                {
                                    RecoveredTurn::Finished(outcome) => break *outcome,
                                    RecoveredTurn::Running(reattached) => {
                                        notifications = reattached.lock_notifications().await;
                                        connection_closed = reattached.closed.subscribe();
                                        connection = reattached;
                                    }
                                }
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
            };
            Ok::<_, HarnessError>(outcome)
        }
        .await;
        self.connection().finish_root_turn(&turn_id);
        let result = match result {
            Ok(outcome) => outcome,
            // Session shutdown closes the connection after publishing the
            // closed signal. Both notifications can therefore become ready
            // in the same select, and the connection error may win even
            // though shutdown is the cause of the interruption.
            Err(_error) if *self.closed_rx.borrow() => cancelled_outcome(
                if run_id.is_none() {
                    CompletionStatus::Interrupted
                } else {
                    CompletionStatus::Cancelled
                },
                None,
            ),
            Err(error) => failed_outcome(error),
        };
        let result = validate_structured_output(result, validation_schema.as_ref());
        if run_id.is_none() {
            self.emit(
                self.root_stream_id.clone(),
                self.root_correlation(Some(turn_id.clone()), None),
                HarnessEventPayloadV1::TurnFinished(result.clone()),
                UpdateSemantics::Snapshot,
            )
            .await?;
        }
        log::info!(
            "[Codex] turn finished turn_id={} status={:?} result_text_len={}",
            turn_id,
            result.status,
            result.result_text.as_deref().map_or(0, str::len)
        );
        trace(
            Some(self.root_session_id.as_str()),
            "turn.finished",
            "provider_to_harness",
            Some(turn_id.as_str()),
            "idle",
            Some(&format!(
                "status={:?}; error={:?}",
                result.status, result.error
            )),
            result.result_text.as_deref(),
        );
        Ok(result)
    }

    pub(super) async fn next_provider_notification(
        &self,
        provider_turn: &str,
        normalized_turn: &TurnId,
        notifications: &mut mpsc::Receiver<NotificationMessage>,
        connection_closed: &mut watch::Receiver<Option<String>>,
        accumulator: &mut TurnAccumulator,
    ) -> Result<Option<TurnOutcome>, HarnessError> {
        tokio::select! {
            // Prefer a terminal notification already buffered ahead of a
            // connection close observed in the same poll.
            biased;
            notification = notifications.recv() => match notification {
                Some(notification) => {
                    let notification = decode_notification(notification.method, notification.params)
                        .map_err(HarnessError::Operation)?;
                    self.process_notification(
                        notification,
                        Some(provider_turn),
                        Some(normalized_turn),
                        accumulator,
                    ).await
                }
                None => Err(HarnessError::Operation(
                    "Codex notification stream closed".into(),
                )),
            },
            closed = connection_closed.changed() => {
                if closed.is_ok()
                    && let Some(error) = connection_closed.borrow().clone()
                {
                    return Err(HarnessError::Operation(error));
                }
                Err(HarnessError::Operation("Codex connection closed without a reason".into()))
            }
        }
    }

    pub(super) async fn wait_for_provider_terminal(
        &self,
        provider_turn: &str,
        normalized_turn: &TurnId,
        notifications: &mut mpsc::Receiver<NotificationMessage>,
        connection_closed: &mut watch::Receiver<Option<String>>,
        accumulator: &mut TurnAccumulator,
    ) -> Result<TurnOutcome, HarnessError> {
        loop {
            if let Some(outcome) = self
                .next_provider_notification(
                    provider_turn,
                    normalized_turn,
                    notifications,
                    connection_closed,
                    accumulator,
                )
                .await?
            {
                return Ok(outcome);
            }
        }
    }
}
