//! Turn-end attention check: does a completed root turn leave the user with
//! something to do before work can continue?
//!
//! The frontend owns the deterministic signals (permission requests,
//! questions, plan approval, gates, errors) and asks here only when none fired.
//! The question, its criteria, the threshold and the input budget live in this
//! module so another decision target can replace the call without changing
//! the attention-state contract.
use super::tool_activity::{decision_fingerprint, digest, Classification};
use super::{AppState, CommandError};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeInstance};
use vertebrae_harness_core::{
    CompletionStatus, EventSink, HarnessError, HarnessEventV1, RequestConfig, RunId, StreamId,
    StructuredInferenceRequest,
};
use vertebrae_sacrum_client::VertebraeConfigFile;

const LOG_TARGET: &str = "chat_attention";
/// Bump when the question, criteria, threshold or budget change; stored
/// answers from another contract are never reused.
const CONTRACT: &str = "turn-attention-v1";
const INSTRUCTIONS: &str = concat!(
    "`message` is the last thing an AI coding agent said at the end of its turn. ",
    "Does it leave the user with something to do before work can continue: a question ",
    "to answer, a choice or confirmation to give, information to supply, or an action only ",
    "the user can take?"
);
const YES: &str = concat!(
    "The agent asks the user something or waits for the user: a question, an offer that ",
    "needs a yes or no (\"Want me to create it?\"), options to choose from, a request for ",
    "missing information, credentials or access, or an action the user must perform first."
);
const NO: &str = concat!(
    "The agent reports finished work or a status and asks nothing (\"Done, all tests pass.\"); ",
    "rhetorical or optional follow-ups such as \"let me know if you need anything else\" do not ",
    "count."
);
/// Above this the turn needs the user.
pub(super) const THRESHOLD: f64 = 0.5;
/// The judged input: the tail of the last assistant message, in Unicode
/// scalar values. Questions usually close a message, so the tail is kept.
pub(super) const MESSAGE_BUDGET_CHARS: usize = 4_000;
/// Turn identities are opaque client keys; bounded before hashing.
const TURN_KEY_MAX_BYTES: usize = 512;
const QUESTION: &str = "needs_user";
const NEEDS_USER_LABEL: &str = "needs_user";

/// One completed root turn to judge or look up.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct TurnAttentionInput {
    pub project_path: Option<String>,
    pub session_id: String,
    /// Opaque, stable identity of the completed turn within the chat.
    pub turn_key: String,
    /// The turn's last assistant message; truncated here, never in the client.
    pub message: String,
    /// Live completions may ask the decision model; replay only looks up.
    pub allow_inference: bool,
}

/// What the turn leaves for the user. `Undecided` means no stored answer
/// exists and none was asked for (history replay).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TurnAttention {
    NeedsYou,
    YourTurn,
    Undecided,
}

/// Probability that a message leaves the user something to do.
#[async_trait]
pub(super) trait TurnJudge: Send + Sync {
    async fn needs_user(&self, message: &str) -> Result<f64, HarnessError>;
}

/// The tail of `message` within the budget, cut at a character boundary.
pub(super) fn judged_message(message: &str) -> String {
    let message = message.trim();
    let count = message.chars().count();
    if count <= MESSAGE_BUDGET_CHARS {
        return message.to_owned();
    }
    let start = message
        .char_indices()
        .nth(count - MESSAGE_BUDGET_CHARS)
        .map_or(0, |(index, _)| index);
    format!("…{}", &message[start..])
}

fn classify(probability: f64) -> TurnAttention {
    if probability > THRESHOLD {
        TurnAttention::NeedsYou
    } else {
        TurnAttention::YourTurn
    }
}

fn fingerprint(config: &VertebraeConfigFile) -> Result<String, CommandError> {
    decision_fingerprint(
        config,
        CONTRACT,
        serde_json::Map::from_iter([
            ("instructions".into(), json!(INSTRUCTIONS)),
            ("criteria".into(), json!({ "true": YES, "false": NO })),
            ("threshold".into(), json!(THRESHOLD)),
            ("budget".into(), json!(MESSAGE_BUDGET_CHARS)),
        ]),
    )
}

fn turn_id(turn_key: &str) -> String {
    digest(format!("{CONTRACT}\0{turn_key}").as_bytes())
}

/// The outcome and, after a fresh answer, the record to store.
#[derive(Debug, PartialEq)]
pub(super) struct Judgement {
    pub attention: TurnAttention,
    pub store: Option<Classification>,
}

/// Reuses a stored answer for the same turn, input and decision settings;
/// otherwise asks `judge` once when inference is allowed. A missing judge
/// (disabled decision model) or a failed answer falls back to your-turn and
/// is never stored.
pub(super) async fn judge_turn(
    judge: Option<&dyn TurnJudge>,
    fingerprint: &str,
    turn_key: &str,
    message: &str,
    persisted: &[Classification],
    allow_inference: bool,
) -> Judgement {
    let message = judged_message(message);
    let tool_id = turn_id(turn_key);
    let input_hash = digest(message.as_bytes());
    if let Some(found) = persisted.iter().find(|entry| {
        entry.tool_id == tool_id
            && entry.input_hash == input_hash
            && entry.classifier_fingerprint == fingerprint
    }) {
        tracing::debug!(target: LOG_TARGET, event = "durable_hit", turn = %tool_id);
        let needs_user = found.labels.iter().any(|label| label == NEEDS_USER_LABEL);
        return Judgement {
            attention: if needs_user {
                TurnAttention::NeedsYou
            } else {
                TurnAttention::YourTurn
            },
            store: None,
        };
    }
    if !allow_inference {
        return Judgement {
            attention: TurnAttention::Undecided,
            store: None,
        };
    }
    let Some(judge) = judge else {
        tracing::debug!(target: LOG_TARGET, event = "fallback", reason = "decision_model_disabled");
        return Judgement {
            attention: TurnAttention::YourTurn,
            store: None,
        };
    };
    if message.is_empty() {
        return Judgement {
            attention: TurnAttention::YourTurn,
            store: None,
        };
    }
    match judge.needs_user(&message).await {
        Ok(probability) => {
            let attention = classify(probability);
            tracing::info!(target: LOG_TARGET, event = "decision", turn = %tool_id,
                needs_user = attention == TurnAttention::NeedsYou, message_chars = message.chars().count());
            Judgement {
                attention,
                store: Some(Classification {
                    tool_id,
                    input_hash,
                    classifier_fingerprint: fingerprint.to_owned(),
                    labels: if attention == TurnAttention::NeedsYou {
                        vec![NEEDS_USER_LABEL.into()]
                    } else {
                        vec![]
                    },
                }),
            }
        }
        Err(error) => {
            tracing::warn!(target: LOG_TARGET, event = "fallback", reason = %failure(&error));
            Judgement {
                attention: TurnAttention::YourTurn,
                store: None,
            }
        }
    }
}

/// Fixed categories only: never log provider payloads, URLs or credentials.
fn failure(error: &HarnessError) -> &'static str {
    match error {
        HarnessError::Unavailable(_) => "decision_provider_unavailable",
        HarnessError::Unsupported(_) => "structured_inference_unsupported",
        _ if error.to_string().to_lowercase().contains("timed out") => "timeout",
        _ => "provider_failed_or_malformed",
    }
}

struct DiscardEvents;

#[async_trait]
impl EventSink for DiscardEvents {
    async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
        Ok(())
    }
}

/// The configured decision role, through the provider-neutral harness runtime.
struct DecisionRuntimeJudge(HarnessRuntimeInstance);

#[async_trait]
impl TurnJudge for DecisionRuntimeJudge {
    async fn needs_user(&self, message: &str) -> Result<f64, HarnessError> {
        let instance = &self.0;
        if !instance.runtime.capabilities().await?.structured_inference {
            return Err(HarnessError::Unsupported(
                "The decision harness must support structured inference.".into(),
            ));
        }
        let request = StructuredInferenceRequest {
            run_id: RunId::new(uuid::Uuid::new_v4().to_string()),
            stream_id: StreamId::new(uuid::Uuid::new_v4().to_string()),
            state: json!({ "message": message }),
            model: instance.request_config.model.clone(),
            questions: BTreeMap::from([(
                QUESTION.to_owned(),
                json!({
                    "type": "noul",
                    "instructions": INSTRUCTIONS,
                    "criteria": { "true": YES, "false": NO },
                }),
            )]),
        };
        let run = instance
            .runtime
            .run_structured_inference(request, Arc::new(DiscardEvents))
            .await?;
        let outcome = match tokio::time::timeout(Duration::from_secs(20), run.await_outcome()).await
        {
            Ok(result) => result?,
            Err(_) => {
                let _ = tokio::time::timeout(Duration::from_secs(2), run.cancel()).await;
                return Err(HarnessError::Operation("Decision timed out.".into()));
            }
        };
        if outcome.status != CompletionStatus::Completed {
            return Err(HarnessError::Operation("Decision did not complete.".into()));
        }
        outcome
            .structured_output
            .as_ref()
            .and_then(|answers| answers[QUESTION]["noul"].as_f64())
            .filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
            .ok_or_else(|| HarnessError::Operation("Invalid attention answer.".into()))
    }
}

fn decision_judge(
    config: &VertebraeConfigFile,
) -> Result<Option<DecisionRuntimeJudge>, HarnessError> {
    if !config.decision_model.enabled {
        return Ok(None);
    }
    let mut factory = HarnessFactoryConfig::from_environment_with_typesafe_configured_settings(
        config.typesafe.api_key.clone(),
        config.typesafe.url.clone(),
    );
    factory.typesafe_api_key_secret = config.typesafe.api_key_secret.clone();
    factory.provider_profiles = config.providers.clone();
    Ok(HarnessRuntimeFactory::new(factory)
        .create_decision_runtime(&config.decision_model, RequestConfig::default())?
        .map(DecisionRuntimeJudge))
}

fn invalid(message: &str) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

/// Judge a completed root turn, reusing the chat catalog's stored answer for
/// it. Model problems never fail the command: they fall back to your-turn
/// with a diagnostic under the `chat_attention` log target.
#[tauri::command]
#[specta::specta]
pub async fn classify_chat_turn_attention(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: TurnAttentionInput,
) -> Result<TurnAttention, CommandError> {
    if input.turn_key.is_empty() || input.turn_key.len() > TURN_KEY_MAX_BYTES {
        return Err(invalid("Expected a turn key of 1 to 512 bytes."));
    }
    let config = tokio::task::spawn_blocking(vertebrae_sacrum_client::load_config_file)
        .await
        .ok()
        .and_then(Result::ok);
    let Some(config) = config else {
        tracing::warn!(target: LOG_TARGET, event = "fallback", reason = "settings_unavailable");
        return Ok(if input.allow_inference {
            TurnAttention::YourTurn
        } else {
            TurnAttention::Undecided
        });
    };
    let fingerprint = fingerprint(&config)?;

    // The durable record is optional: without a catalog the answer still counts.
    let expected_connection = state
        .sacrum_client
        .read()
        .await
        .as_ref()
        .map(|client| client.connection_identity().to_string());
    let persisted = match &input.project_path {
        Some(project_path) => {
            super::chat_catalog::load_classifications(&state, project_path, &input.session_id)
                .await
                .ok()
        }
        None => None,
    };

    let judge = match decision_judge(&config) {
        Ok(judge) => judge,
        Err(error) => {
            tracing::warn!(target: LOG_TARGET, event = "fallback", reason = %failure(&error));
            None
        }
    };
    let judgement = judge_turn(
        judge.as_ref().map(|j| j as &dyn TurnJudge),
        &fingerprint,
        &input.turn_key,
        &input.message,
        persisted.as_deref().unwrap_or_default(),
        input.allow_inference,
    )
    .await;

    if let (Some(record), Some(project_path), Some(connection), Some(_)) = (
        judgement.store,
        &input.project_path,
        &expected_connection,
        &persisted,
    ) {
        if super::chat_catalog::store_classifications(
            &state,
            &app,
            project_path,
            &input.session_id,
            vec![record],
            connection,
        )
        .await
        .is_err()
        {
            // Capacity (`chat_classification_capacity`) or catalog failures keep
            // the answer for this session; the next restart asks no model either.
            tracing::warn!(target: LOG_TARGET, event = "store_failed", chat_id = %input.session_id);
        }
    }
    Ok(judgement.attention)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Counts calls; answers from a fixed table keyed by message suffix.
    struct CountingJudge {
        calls: AtomicUsize,
        answer: Result<f64, ()>,
    }

    impl CountingJudge {
        fn new(answer: Result<f64, ()>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                answer,
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl TurnJudge for CountingJudge {
        async fn needs_user(&self, _message: &str) -> Result<f64, HarnessError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.answer
                .map_err(|_| HarnessError::Operation("malformed".into()))
        }
    }

    /// Answers like a model would for the ticket's two fixture messages.
    struct FixtureJudge(AtomicUsize);

    #[async_trait]
    impl TurnJudge for FixtureJudge {
        async fn needs_user(&self, message: &str) -> Result<f64, HarnessError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(if message.ends_with('?') { 0.93 } else { 0.04 })
        }
    }

    const FINGERPRINT: &str = "fixture-fingerprint";

    #[tokio::test]
    async fn questions_need_you_and_reports_are_your_turn() {
        let judge = FixtureJudge(AtomicUsize::new(0));
        let asked = judge_turn(
            Some(&judge),
            FINGERPRINT,
            "t1",
            "Want me to create it?",
            &[],
            true,
        )
        .await;
        let done = judge_turn(
            Some(&judge),
            FINGERPRINT,
            "t2",
            "Done, all tests pass.",
            &[],
            true,
        )
        .await;
        assert_eq!(asked.attention, TurnAttention::NeedsYou);
        assert_eq!(asked.store.unwrap().labels, vec!["needs_user"]);
        assert_eq!(done.attention, TurnAttention::YourTurn);
        // A successful "no" is stored too, so replay never asks again.
        assert_eq!(done.store.unwrap().labels, Vec::<String>::new());
        assert_eq!(judge.0.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn threshold_boundaries_map_to_needs_you_and_your_turn() {
        for (probability, expected) in [
            (THRESHOLD + 0.001, TurnAttention::NeedsYou),
            (THRESHOLD, TurnAttention::YourTurn),
            (THRESHOLD - 0.001, TurnAttention::YourTurn),
        ] {
            let judge = CountingJudge::new(Ok(probability));
            let judgement = judge_turn(Some(&judge), FINGERPRINT, "t", "Ok?", &[], true).await;
            assert_eq!(judgement.attention, expected, "p={probability}");
        }
    }

    #[tokio::test]
    async fn replaying_a_stored_turn_makes_no_additional_calls() {
        let judge = CountingJudge::new(Ok(0.9));
        let first = judge_turn(Some(&judge), FINGERPRINT, "turn", "Proceed?", &[], true).await;
        let stored: Vec<Classification> =
            serde_json::from_slice(&serde_json::to_vec(&[first.store.unwrap()]).unwrap()).unwrap();
        for allow_inference in [true, false] {
            let replay = judge_turn(
                Some(&judge),
                FINGERPRINT,
                "turn",
                "Proceed?",
                &stored,
                allow_inference,
            )
            .await;
            assert_eq!(replay.attention, TurnAttention::NeedsYou);
            assert!(replay.store.is_none());
        }
        assert_eq!(judge.calls(), 1);
    }

    #[tokio::test]
    async fn replay_without_a_stored_answer_never_asks() {
        let judge = CountingJudge::new(Ok(0.9));
        let replay = judge_turn(Some(&judge), FINGERPRINT, "turn", "Proceed?", &[], false).await;
        assert_eq!(replay.attention, TurnAttention::Undecided);
        assert_eq!(judge.calls(), 0);
    }

    #[tokio::test]
    async fn changed_settings_or_input_invalidate_the_stored_answer() {
        let judge = CountingJudge::new(Ok(0.9));
        let first = judge_turn(Some(&judge), FINGERPRINT, "turn", "Proceed?", &[], true).await;
        let stored = vec![first.store.unwrap()];
        judge_turn(
            Some(&judge),
            "other-settings",
            "turn",
            "Proceed?",
            &stored,
            true,
        )
        .await;
        judge_turn(
            Some(&judge),
            FINGERPRINT,
            "turn",
            "Proceed now?",
            &stored,
            true,
        )
        .await;
        assert_eq!(judge.calls(), 3);
    }

    #[tokio::test]
    async fn disabled_model_yields_your_turn_without_calls_or_records() {
        let judgement = judge_turn(
            None,
            FINGERPRINT,
            "turn",
            "Want me to create it?",
            &[],
            true,
        )
        .await;
        assert_eq!(
            judgement,
            Judgement {
                attention: TurnAttention::YourTurn,
                store: None
            }
        );
    }

    #[tokio::test]
    async fn failures_fall_back_to_your_turn_and_are_not_stored() {
        let judge = CountingJudge::new(Err(()));
        let judgement = judge_turn(Some(&judge), FINGERPRINT, "turn", "Proceed?", &[], true).await;
        assert_eq!(judgement.attention, TurnAttention::YourTurn);
        assert!(judgement.store.is_none());
        assert_eq!(judge.calls(), 1);
    }

    #[test]
    fn disabled_settings_build_no_judge() {
        assert!(decision_judge(&VertebraeConfigFile::default())
            .unwrap()
            .is_none());
    }

    #[test]
    fn judged_message_keeps_the_tail_within_budget_at_char_boundaries() {
        let long = format!(
            "{}{}",
            "é".repeat(MESSAGE_BUDGET_CHARS),
            "Want me to create it?"
        );
        let judged = judged_message(&long);
        assert!(judged.starts_with('…'));
        assert!(judged.ends_with("Want me to create it?"));
        assert_eq!(judged.chars().count(), MESSAGE_BUDGET_CHARS + 1);
        assert_eq!(judged_message("  short  "), "short");
    }

    #[test]
    fn stored_records_satisfy_the_catalog_wire_contract() {
        let record = Classification {
            tool_id: turn_id("turn"),
            input_hash: digest(b"m"),
            classifier_fingerprint: fingerprint(&VertebraeConfigFile::default()).unwrap(),
            labels: vec![NEEDS_USER_LABEL.into()],
        };
        let hex64 = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
        assert!(
            hex64(&record.tool_id)
                && hex64(&record.input_hash)
                && hex64(&record.classifier_fingerprint)
        );
        assert_ne!(
            turn_id("turn"),
            digest(b"turn"),
            "turn ids never collide with invocation hashes"
        );
    }
}
