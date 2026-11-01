//! A turn remains unsent until its settings requests have been acknowledged.
//! Only this process owner records confirmed settings. Requests are separate
//! per field so a partial rejection cannot falsely confirm another field.
use std::collections::HashMap;

use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};
use vertebrae_harness_core::{SendTurnRequest, SpeedTier, TurnOutcome, TurnSettings};

use super::OutcomeState;
use crate::ClaudePermissionMode;

pub(super) struct TurnSubmission {
    pub request: SendTurnRequest,
    pub outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
    pub response: oneshot::Sender<Result<(), String>>,
}

impl TurnSubmission {
    pub fn reject(self, error: String) {
        let _ = self.outcome_tx.send(OutcomeState::Failed(error.clone()));
        let _ = self.response.send(Err(error));
    }
}

pub(super) struct PendingSettings {
    pub submission: TurnSubmission,
    pub requests: Vec<Value>,
    pending: HashMap<String, TurnSettings>,
    error: Option<String>,
}

impl PendingSettings {
    pub fn new(submission: TurnSubmission, confirmed: &TurnSettings) -> Self {
        let changes = confirmed.changes(&submission.request.settings);
        let mut requests = Vec::new();
        let mut pending = HashMap::new();
        let mut add = |field: &str, request: Value, applied: TurnSettings| {
            // Attempt identity must differ even if a caller retries a turn id.
            let id = format!(
                "vertebrae-settings:{}:{field}:{}",
                submission.request.turn_id,
                uuid::Uuid::new_v4()
            );
            requests.push(json!({"type": "control_request", "request_id": id, "request": request}));
            pending.insert(id, applied);
        };
        if let Some(mode) = &changes.permission_mode {
            add(
                "permission_mode",
                json!({"subtype": "set_permission_mode", "mode": ClaudePermissionMode::from(mode).as_cli_value()}),
                TurnSettings {
                    permission_mode: Some(mode.clone()),
                    ..Default::default()
                },
            );
        }
        if let Some(model) = &changes.model {
            add(
                "model",
                json!({"subtype": "apply_flag_settings", "settings": {"model": model}}),
                TurnSettings {
                    model: Some(model.clone()),
                    ..Default::default()
                },
            );
        }
        if let Some(effort) = &changes.reasoning_effort {
            add(
                "effort",
                json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": effort}}),
                TurnSettings {
                    reasoning_effort: Some(effort.clone()),
                    ..Default::default()
                },
            );
        }
        if let Some(tier) = changes.speed_tier {
            add(
                "speed_tier",
                json!({"subtype": "apply_flag_settings", "settings": {"fastMode": tier == SpeedTier::Fast}}),
                TurnSettings {
                    speed_tier: Some(tier),
                    ..Default::default()
                },
            );
        }
        Self {
            submission,
            requests,
            pending,
            error: None,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.pending.is_empty()
    }

    /// Consume only an acknowledgement for this attempt. Unrelated, duplicate,
    /// late and malformed responses cannot confirm settings or release a prompt.
    pub fn resolve(&mut self, record: &Value, confirmed: &mut TurnSettings) -> bool {
        if record.get("type").and_then(Value::as_str) != Some("control_response") {
            return false;
        }
        let Some(response) = record.get("response") else {
            return false;
        };
        let Some(id) = response.get("request_id").and_then(Value::as_str) else {
            return false;
        };
        let Some(applied) = self.pending.get(id) else {
            return false;
        };
        match response.get("subtype").and_then(Value::as_str) {
            Some("success") => confirmed.merge(applied.clone()),
            Some("error") => {
                self.error.get_or_insert_with(|| {
                    format!(
                        "Claude rejected session settings: {}. Message was not sent.",
                        response
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("no reason given")
                    )
                });
            }
            _ => return false,
        }
        self.pending.remove(id);
        true
    }

    pub fn finish(self) -> Option<TurnSubmission> {
        if let Some(error) = self.error {
            self.submission.reject(error);
            None
        } else {
            Some(self.submission)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_harness_core::TurnId;

    fn pending() -> PendingSettings {
        let (response, _) = oneshot::channel();
        let (outcome_tx, _) = watch::channel(OutcomeState::Pending);
        PendingSettings::new(
            TurnSubmission {
                request: SendTurnRequest {
                    turn_id: TurnId::new("reused"),
                    content: "prompt".into(),
                    output_schema: None,
                    settings: TurnSettings {
                        model: Some("new-model".into()),
                        ..Default::default()
                    },
                },
                response,
                outcome_tx,
            },
            &TurnSettings::default(),
        )
    }

    #[test]
    fn only_a_matching_well_formed_acknowledgement_can_confirm_settings() {
        let mut first = pending();
        let mut confirmed = TurnSettings::default();
        let id = first.requests[0]["request_id"].clone();
        assert!(!first.resolve(&json!({"type":"control_response", "response":{"request_id":"unrelated", "subtype":"success"}}), &mut confirmed));
        assert!(!first.resolve(
            &json!({"type":"control_response", "response":{"request_id":id, "subtype":"unknown"}}),
            &mut confirmed
        ));
        assert!(!first.is_complete());
        assert!(confirmed.is_empty());
        let ack =
            json!({"type":"control_response", "response":{"request_id":id, "subtype":"success"}});
        assert!(first.resolve(&ack, &mut confirmed));
        assert!(first.is_complete());
        assert_eq!(confirmed.model.as_deref(), Some("new-model"));
        assert!(!first.resolve(&ack, &mut confirmed), "duplicate response");
        let mut retry = pending();
        let mut retry_confirmed = TurnSettings::default();
        assert!(
            !retry.resolve(&ack, &mut retry_confirmed),
            "late response from an older attempt"
        );
        assert!(!retry.is_complete());
        assert!(retry_confirmed.is_empty());
    }
}
