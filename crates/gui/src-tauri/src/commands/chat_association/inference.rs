use super::{AssociationSelection, AssociationTicket};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeInstance};
use vertebrae_harness_core::{
    EventSink, HarnessError, HarnessEventV1, RequestConfig, RunId, StreamId,
    StructuredInferenceRequest,
};
use vertebrae_sacrum_client::VertebraeConfigFile;

const IMPLEMENT_QUESTION: &str = "Is this message asking we implement a ticket?";
const CREATE_WORKTREE_QUESTION: &str = "Is this message asking we create a worktree?";
const TICKET_QUESTION: &str = concat!(
    "Which ticket is the user asking to implement or create a worktree for? ",
    "Choose unknown if the message does not identify one of the available tickets."
);

/// The association so far; only its missing parts are asked about.
#[derive(Clone, Copy, Default)]
pub(super) struct State<'a> {
    pub ticket_id: Option<&'a str>,
    pub worktree_path: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Decision {
    pub selection: AssociationSelection,
    pub create_worktree: bool,
}

struct DiscardEvents;

#[async_trait]
impl EventSink for DiscardEvents {
    async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
        Ok(())
    }
}

/// Asks the missing intent questions in one request; a ticket choice follows only
/// when an intent is present, no ticket is known and the message names none.
pub(super) async fn decide(
    config: &VertebraeConfigFile,
    message: &str,
    candidates: &[AssociationTicket],
    state: State<'_>,
    attempt: &str,
) -> Result<Decision, HarnessError> {
    let started = std::time::Instant::now();
    let result = decide_inner(config, message, candidates, state, attempt).await;
    log::info!(target: "chat_association", "attempt={} phase=decision_finish elapsed_ms={} outcome={} reason={}",
        attempt, started.elapsed().as_millis(), match &result {
            Ok(Decision { selection: AssociationSelection::Ticket { .. }, .. }) => "ticket",
            Ok(Decision { selection: AssociationSelection::Unknown, .. }) => "unknown",
            Ok(_) => "keep", Err(_) => "error",
        }, result.as_ref().err().map(diagnostic).unwrap_or_default());
    result
}

async fn decide_inner(
    config: &VertebraeConfigFile,
    message: &str,
    candidates: &[AssociationTicket],
    state: State<'_>,
    attempt: &str,
) -> Result<Decision, HarnessError> {
    log::info!(target: "chat_association", "attempt={} phase=decision enabled={}", attempt, config.decision_model.enabled);
    let keep = Decision {
        selection: AssociationSelection::Keep,
        create_worktree: false,
    };
    let mut questions = BTreeMap::new();
    if state.ticket_id.is_none() {
        questions.insert("implement", IMPLEMENT_QUESTION);
    }
    if state.worktree_path.is_none() {
        questions.insert("create_worktree", CREATE_WORKTREE_QUESTION);
    }
    if questions.is_empty() {
        return Ok(keep);
    }

    let mut factory_config =
        HarnessFactoryConfig::from_environment_with_typesafe_configured_settings(
            config.typesafe.api_key.clone(),
            config.typesafe.url.clone(),
        );
    factory_config.typesafe_api_key_secret = config.typesafe.api_key_secret.clone();
    factory_config.provider_profiles = config.providers.clone();
    let instance = HarnessRuntimeFactory::new(factory_config)
        .create_decision_runtime(&config.decision_model, RequestConfig::default())?
        .ok_or_else(|| HarnessError::Unavailable("Decision model disabled.".into()))?;
    if !instance.runtime.capabilities().await?.structured_inference {
        return Err(HarnessError::Unsupported(
            "The decision harness must support structured inference.".into(),
        ));
    }

    let request = questions
        .iter()
        .map(|(name, text)| {
            (
                name.to_string(),
                json!({ "type": "noul", "instructions": text }),
            )
        })
        .collect();
    let answers = ask(&instance, request, message, state, attempt).await?;
    let intents = questions
        .keys()
        .map(|name| {
            answers[*name]["noul"]
                .as_f64()
                .filter(|value| (0.0..=1.0).contains(value))
                .map(|value| (*name, value > 0.5))
                .ok_or_else(|| HarnessError::Operation("Invalid intent answer.".into()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let create_worktree = intents.get("create_worktree") == Some(&true);
    if !intents.values().any(|asked| *asked) {
        return Ok(keep);
    }
    if state.ticket_id.is_some() {
        return Ok(Decision {
            create_worktree,
            ..keep
        });
    }

    log::info!(target: "chat_association", "attempt={} phase=intent implement={} create_worktree={} candidates={}", attempt, intents.get("implement") == Some(&true), create_worktree, candidates.len());
    let selection = if let Some(ticket) = named_ticket(message, candidates) {
        AssociationSelection::Ticket {
            id: ticket.id.clone(),
        }
    } else if candidates.is_empty() {
        AssociationSelection::Unknown
    } else {
        let mut choices = serde_json::Map::new();
        choices.insert("unknown".into(), json!("No identifiable matching ticket."));
        for ticket in candidates {
            choices.insert(ticket.id.clone(), json!(ticket.title));
        }
        let question = json!({
            "type": "choice",
            "instructions": TICKET_QUESTION,
            "criteria": choices,
        });
        let answers = ask(
            &instance,
            BTreeMap::from([("ticket".into(), question)]),
            message,
            state,
            attempt,
        )
        .await?;
        match answers["ticket"]["choice"]
            .as_str()
            .filter(|c| choices.contains_key(*c))
        {
            Some("unknown") => AssociationSelection::Unknown,
            Some(id) => AssociationSelection::Ticket { id: id.into() },
            None => return Err(HarnessError::Operation("Invalid ticket choice.".into())),
        }
    };
    Ok(Decision {
        selection,
        create_worktree,
    })
}

/// The single cached ticket whose full ID or 8+ character ID prefix the message contains.
fn named_ticket<'a>(
    message: &str,
    candidates: &'a [AssociationTicket],
) -> Option<&'a AssociationTicket> {
    let message = message.to_lowercase();
    let tokens: Vec<&str> = message
        .split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .filter(|token| token.len() >= 8)
        .collect();
    let mut named = candidates.iter().filter(|ticket| {
        let id = ticket.id.to_lowercase();
        tokens.iter().any(|token| id.starts_with(token))
    });
    match (named.next(), named.next()) {
        (Some(ticket), None) => Some(ticket),
        _ => None,
    }
}

async fn ask(
    instance: &HarnessRuntimeInstance,
    questions: BTreeMap<String, Value>,
    message: &str,
    state: State<'_>,
    attempt: &str,
) -> Result<Value, HarnessError> {
    let names: Vec<String> = questions.keys().cloned().collect();
    let request = StructuredInferenceRequest {
        run_id: RunId::new(uuid::Uuid::new_v4().to_string()),
        stream_id: StreamId::new(uuid::Uuid::new_v4().to_string()),
        state: json!({
            "message": message,
            "current_ticket": state.ticket_id,
            "current_worktree": state.worktree_path,
        }),
        model: instance.request_config.model.clone(),
        questions,
    };
    let started = std::time::Instant::now();
    let request_id = request.run_id.clone();
    log::info!(target: "chat_association", "attempt={} phase=request request_id={:?} destination=decision_runtime harness={:?} questions={:?} message_bytes={}", attempt, request_id, instance.harness, names, message.len());
    let response = async {
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
        let answers = outcome.structured_output.ok_or_else(|| {
            HarnessError::Operation(
                outcome
                    .error
                    .unwrap_or_else(|| "No decision returned.".into()),
            )
        })?;
        if names.iter().any(|name| answers.get(name).is_none()) {
            return Err(HarnessError::Operation(
                "The requested answer is missing.".into(),
            ));
        }
        Ok(answers)
    }
    .await;
    log::info!(target: "chat_association", "attempt={} phase=response request_id={:?} elapsed_ms={} status={} reason={}", attempt, request_id, started.elapsed().as_millis(), if response.is_ok() { "ok" } else { "error" }, response.as_ref().err().map(diagnostic).unwrap_or_default());
    if std::env::var("VTB_ASSOCIATION_DIAGNOSTIC_PAYLOADS").as_deref() == Ok("1") {
        // Strict allowlist: never serialize arbitrary provider keys, strings or errors.
        if let Ok(answers) = &response {
            let summary: BTreeMap<_, _> = names.iter().map(|name| {
                let answer = &answers[name];
                (name.as_str(), json!({
                    "probability": answer["noul"].as_f64().filter(|p| (0.0..=1.0).contains(p)),
                    "has_choice": answer["choice"].is_string(),
                }))
            }).collect();
            log::info!(target: "chat_association", "attempt={} phase=response_summary request_id={:?} content={}", attempt, request_id, json!(summary));
        }
    }
    response
}

/// Fixed text only: never forward provider payloads, URLs or credentials into chat.
pub(super) fn diagnostic(error: &HarnessError) -> String {
    match error {
        HarnessError::Unavailable(_) => {
            "Cannot prepare the decision provider. Check its saved credential and availability."
        }
        HarnessError::Unsupported(_) => {
            "The configured harness does not support structured decisions."
        }
        _ if error.to_string().to_lowercase().contains("timed out") => {
            "Decision request timed out."
        }
        _ => "The decision provider failed or returned an invalid response.",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

    const ID: &str = "f6f6bf5e-2ca1-4e50-bcfa-9e08944eaa78";

    fn tickets() -> Vec<AssociationTicket> {
        vec![
            AssociationTicket {
                id: ID.into(),
                title: "Codex retry status".into(),
            },
            AssociationTicket {
                id: "97a3edab-5e4a-40a8-b580-19708657a222".into(),
                title: "Conversation associations".into(),
            },
        ]
    }

    /// Runs `decide` against a mock provider; returns the decision and request bodies.
    async fn run(
        message: &str,
        state: State<'_>,
        intents: Value,
        choice: Option<&str>,
    ) -> (Decision, Vec<Value>) {
        let server = MockServer::start().await;
        let mut config = VertebraeConfigFile::default();
        config.decision_model.enabled = true;
        config.decision_model.provider = Some(vertebrae_core::ProviderId::typesafe());
        config.decision_model.model = Some("jev-latest".into());
        config.typesafe.api_key = Some("fixture-key".into());
        config.typesafe.url = Some(format!("{}/v1/systemone", server.uri()));
        let respond = |answers: Value| {
            ResponseTemplate::new(200).set_body_json(json!({
                "model": "jev-1.14.0",
                "answers": answers,
                "usage": { "input_tokens": 1, "output_tokens": 1 },
            }))
        };
        let noul = |p: f64| json!({ "type": "noul", "noul": p });
        let mut answers = serde_json::Map::new();
        for (name, p) in intents.as_object().unwrap() {
            answers.insert(name.clone(), noul(p.as_f64().unwrap()));
        }
        let first = intents.as_object().unwrap().keys().next().unwrap().clone();
        Mock::given(matchers::body_partial_json(
            json!({ "questions": { first: {} } }),
        ))
        .respond_with(respond(Value::Object(answers)))
        .mount(&server)
        .await;
        if let Some(choice) = choice {
            let mut probabilities = json!({ "unknown": 0.0 });
            for ticket in tickets() {
                probabilities[ticket.id.as_str()] =
                    json!(if ticket.id == choice { 1.0 } else { 0.0 });
            }
            Mock::given(matchers::body_partial_json(
                json!({ "questions": { "ticket": {} } }),
            ))
            .respond_with(respond(json!({ "ticket": {
                "type": "choice", "choice": choice,
                "probabilities": probabilities, "confidence": 1.0,
            }})))
            .mount(&server)
            .await;
        }
        let decision = decide(&config, message, &tickets(), state, "fixture")
            .await
            .unwrap();
        let bodies = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        (decision, bodies)
    }

    struct CapturedLogs(std::sync::Mutex<Vec<String>>);
    static LOGS: CapturedLogs = CapturedLogs(std::sync::Mutex::new(Vec::new()));
    static LOGGER: std::sync::Once = std::sync::Once::new();
    impl log::Log for CapturedLogs {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.target() == "chat_association"
        }
        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                self.0.lock().unwrap().push(record.args().to_string());
            }
        }
        fn flush(&self) {}
    }

    #[tokio::test]
    async fn diagnostic_logs_cover_resolutions_and_response_failures_without_payloads() {
        LOGGER.call_once(|| {
            log::set_logger(&LOGS).unwrap();
            log::set_max_level(log::LevelFilter::Info);
        });
        let noul = |p| json!({ "type": "noul", "noul": p });
        for (template, candidates, expected) in [
            (ResponseTemplate::new(200).set_body_json(json!({ "model": "jev-1.14.0", "answers": {"implement": noul(0.9), "create_worktree": noul(0.1)}, "usage": {"input_tokens": 1, "output_tokens": 1} })), tickets(), "ticket"),
            (ResponseTemplate::new(200).set_body_json(json!({ "model": "jev-1.14.0", "answers": {"implement": noul(0.9), "create_worktree": noul(0.1)}, "usage": {"input_tokens": 1, "output_tokens": 1} })), vec![], "unknown"),
            (ResponseTemplate::new(503).set_body_string("secret-response"), tickets(), "error"),
            (ResponseTemplate::new(200).set_body_string("secret-malformed-json"), tickets(), "error"),
            (ResponseTemplate::new(200).set_body_json(json!({"model": "jev-1.14.0", "answers": {}, "usage": {"input_tokens": 1, "output_tokens": 1}})), tickets(), "error"),
        ] {
            let server = MockServer::start().await;
            Mock::given(matchers::method("POST")).respond_with(template).mount(&server).await;
            let mut config = VertebraeConfigFile::default();
            config.decision_model.enabled = true;
            config.decision_model.provider = Some(vertebrae_core::ProviderId::typesafe());
            config.decision_model.model = Some("jev-latest".into());
            config.typesafe.api_key = Some("secret-credential".into());
            config.typesafe.url = Some(format!("{}/v1/systemone", server.uri()));
            let attempt = uuid::Uuid::new_v4().to_string();
            let _ = decide(&config, &format!("implement {ID} secret-prompt"), &candidates, State::default(), &attempt).await;
            let lines = LOGS.0.lock().unwrap().iter().filter(|line| line.contains(&attempt)).cloned().collect::<Vec<_>>().join("\n");
            let all = LOGS.0.lock().unwrap().join("\n");
            assert!(!all.contains("secret-"), "{all}");
            assert!(all.contains("phase=http_response status="), "{all}");
            assert!(lines.contains("phase=request"), "{lines}");
            assert!(lines.contains("phase=response"), "{lines}");
            assert!(lines.contains(&format!("outcome={expected}")), "{lines}");
            assert!(!lines.contains("secret-"), "{lines}");
            assert!(!lines.contains(ID), "{lines}");
        }
    }

    #[tokio::test]
    async fn connection_failure_returns_a_safe_diagnostic() {
        let mut config = VertebraeConfigFile::default();
        config.decision_model.enabled = true;
        config.decision_model.provider = Some(vertebrae_core::ProviderId::typesafe());
        config.decision_model.model = Some("jev-latest".into());
        config.typesafe.api_key = Some("secret-credential".into());
        // A deliberately invalid port deterministically refuses a connection without a long timeout.
        config.typesafe.url = Some("http://127.0.0.1:0/v1/systemone".into());
        let error = decide(
            &config,
            "secret-prompt",
            &tickets(),
            State::default(),
            "transport-fixture",
        )
        .await
        .unwrap_err();
        assert_eq!(
            diagnostic(&error),
            "The decision provider failed or returned an invalid response."
        );
    }

    #[tokio::test]
    async fn unrelated_messages_keep_the_association_after_one_request() {
        let (decision, requests) = run(
            "what does this function do?",
            State::default(),
            json!({ "create_worktree": 0.1, "implement": 0.2 }),
            None,
        )
        .await;
        assert_eq!(decision.selection, AssociationSelection::Keep);
        assert!(!decision.create_worktree);
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0]["state"],
            json!({
                "message": "what does this function do?",
                "current_ticket": null,
                "current_worktree": null,
            })
        );
        let asked = requests[0]["questions"].as_object().unwrap();
        assert!(asked.contains_key("implement") && asked.contains_key("create_worktree"));
    }

    #[tokio::test]
    async fn worktree_request_naming_a_ticket_selects_it_without_a_choice() {
        let message = format!("Let's check the {ID}, is it clear? Let's create a worktree for it");
        let (decision, requests) = run(
            &message,
            State::default(),
            json!({ "create_worktree": 0.9, "implement": 0.3 }),
            None,
        )
        .await;
        assert_eq!(
            decision.selection,
            AssociationSelection::Ticket { id: ID.into() }
        );
        assert!(decision.create_worktree);
        assert_eq!(requests.len(), 1);
    }

    #[tokio::test]
    async fn unnamed_implementation_request_asks_which_ticket() {
        let (decision, requests) = run(
            "let's implement the retry status ticket",
            State::default(),
            json!({ "create_worktree": 0.1, "implement": 0.9 }),
            Some(ID),
        )
        .await;
        assert_eq!(
            decision.selection,
            AssociationSelection::Ticket { id: ID.into() }
        );
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn known_ticket_only_asks_about_the_worktree() {
        let (decision, requests) = run(
            "ok, let's implement the ticket in a new worktree",
            State {
                ticket_id: Some(ID),
                worktree_path: None,
            },
            json!({ "create_worktree": 0.9 }),
            None,
        )
        .await;
        assert_eq!(decision.selection, AssociationSelection::Keep);
        assert!(decision.create_worktree);
        assert_eq!(requests.len(), 1);
        let asked = requests[0]["questions"].as_object().unwrap();
        assert_eq!(asked.keys().collect::<Vec<_>>(), ["create_worktree"]);
        assert_eq!(requests[0]["state"]["current_ticket"], json!(ID));
    }

    #[test]
    fn named_ticket_requires_one_unambiguous_id_prefix() {
        let all = tickets();
        assert_eq!(
            named_ticket("implement F6F6BF5E please", &all).map(|t| t.id.as_str()),
            Some(ID)
        );
        assert!(named_ticket("implement f6f6bf5", &all).is_none());
        assert!(named_ticket("implement the retry ticket", &all).is_none());
        assert!(named_ticket("compare f6f6bf5e and 97a3edab", &all).is_none());
    }
}
