use super::references::{self, EntityLookup, Named};
use super::{AssociationEntity, AssociationSelection, AssociationWorktree};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeInstance};
use vertebrae_harness_core::{
    EventSink, HarnessError, HarnessEventV1, RequestConfig, RunId, StreamId,
    StructuredInferenceRequest,
};
use vertebrae_sacrum_client::VertebraeConfigFile;

/// A yes/no intent question with the boundary between its answers.
pub(super) struct Intent {
    instructions: &'static str,
    yes: &'static str,
    no: &'static str,
}

const SELECT_ENTITY: Intent = Intent {
    instructions: concat!(
        "Does `message` ask to look at, discuss, implement, create a worktree for, or tie ",
        "this conversation to an epic, ticket or task? An entity may be named only by its ID, without naming its ",
        "level: its full UUID, or its short ID, which is the first 8 characters ",
        "of the UUID. `named_entities` lists the entities whose full or short IDs appear in `message`."
    ),
    yes: concat!(
        "`message` asks to work with or about an entity: one it describes, or one of ",
        "`named_entities` named by its full UUID or by its 8-character short ID."
    ),
    no: concat!(
        "`message` asks nothing about an entity, or an ID in it only appears in passing, ",
        "such as a commit hash, a log line or quoted output."
    ),
};

const CREATE_WORKTREE: Intent = Intent {
    instructions: "Does `message` ask to create a new worktree?",
    yes: "`message` asks to create a new worktree, for an entity or otherwise.",
    no: concat!(
        "`message` asks for no new worktree: it does not mention one, or it refers to a ",
        "worktree that already exists."
    ),
};

const SELECT_WORKTREE: Intent = Intent {
    instructions: concat!(
        "Does `message` ask to tie this conversation to an existing worktree, named by its ",
        "path, directory name or branch?"
    ),
    yes: concat!(
        "`message` asks to tie, bind, switch or move this conversation to a worktree that ",
        "already exists."
    ),
    no: concat!(
        "`message` asks to create a new worktree, or mentions worktrees without asking to ",
        "tie this conversation to one."
    ),
};

const ENTITY_QUESTION: &str = concat!(
    "Which epic, ticket or task does `message` ask to look at, discuss, implement or create a worktree for, or bind this conversation to? ",
    "Choose unknown if `message` does not identify one of the available entities. ",
    "Respect the requested level; never substitute its parent ticket or epic."
);

/// The association so far; only its missing parts are asked about.
#[derive(Clone, Copy, Default)]
pub(super) struct State<'a> {
    pub current_entity: Option<&'a AssociationEntity>,
    pub worktree_path: Option<&'a str>,
}

/// What a decision may resolve against: cached entities, the project's entity
/// lookup and its Git worktree inventory.
#[derive(Clone, Copy)]
pub(super) struct Scope<'a> {
    pub candidates: &'a [AssociationEntity],
    pub lookup: &'a dyn EntityLookup,
    pub worktrees: &'a [AssociationWorktree],
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Decision {
    pub selection: AssociationSelection,
    /// An existing worktree the user explicitly tied to the conversation.
    pub worktree: Option<AssociationWorktree>,
    pub create_worktree: bool,
    /// An unresolved or ambiguous explicit reference; nothing was guessed.
    pub diagnostic: Option<String>,
}

struct DiscardEvents;

#[async_trait]
impl EventSink for DiscardEvents {
    async fn emit(&self, _event: HarnessEventV1) -> Result<(), HarnessError> {
        Ok(())
    }
}

/// The intent questions a message warrants. A missing part is always asked
/// about; a known association changes only on an explicit entity ID or a
/// message about a worktree. Empty means the message cannot change anything.
pub(super) fn questions(message: &str, state: State<'_>) -> BTreeMap<&'static str, Intent> {
    let names_entity = !references::entity_tokens(message).is_empty();
    let mut questions = BTreeMap::new();
    if state.current_entity.is_none() || names_entity {
        questions.insert("select_entity", SELECT_ENTITY);
    }

    if state.worktree_path.is_none() || names_entity {
        questions.insert("create_worktree", CREATE_WORKTREE);
    }

    if references::mentions_worktree(message) {
        questions.insert("select_worktree", SELECT_WORKTREE);
    }
    questions
}

/// Asks the warranted intent questions in one request, then resolves explicit
/// references deterministically; an entity choice follows only when an entity
/// intent is present, no entity is known and the message names none.
pub(super) async fn decide(
    config: &VertebraeConfigFile,
    message: &str,
    scope: Scope<'_>,
    state: State<'_>,
    attempt: &str,
) -> Result<Decision, HarnessError> {
    let started = std::time::Instant::now();
    let result = decide_inner(config, message, scope, state, attempt).await;

    log::info!(target: "chat_association", "attempt={} phase=decision_finish elapsed_ms={} outcome={} worktree={} unresolved={} reason={}",
        attempt, started.elapsed().as_millis(), match &result {
            Ok(Decision { selection: AssociationSelection::Entity { .. }, .. }) => "entity",
            Ok(Decision { selection: AssociationSelection::Unknown, .. }) => "unknown",
            Ok(_) => "keep", Err(_) => "error",
        },
        result.as_ref().is_ok_and(|d| d.worktree.is_some()),
        result.as_ref().is_ok_and(|d| d.diagnostic.is_some()),
        result.as_ref().err().map(diagnostic).unwrap_or_default());

    result
}

async fn decide_inner(
    config: &VertebraeConfigFile,
    message: &str,
    scope: Scope<'_>,
    state: State<'_>,
    attempt: &str,
) -> Result<Decision, HarnessError> {
    log::info!(target: "chat_association", "attempt={} phase=decision enabled={}", attempt, config.decision_model.enabled);
    let mut decision = Decision {
        selection: AssociationSelection::Keep,
        worktree: None,
        create_worktree: false,
        diagnostic: None,
    };

    let questions = questions(message, state);
    if questions.is_empty() {
        return Ok(decision);
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
        .map(|(name, intent)| {
            (
                name.to_string(),
                json!({
                    "type": "noul",
                    "instructions": intent.instructions,
                    "criteria": { "true": intent.yes, "false": intent.no },
                }),
            )
        })
        .collect();

    // IDs are matched here, not by the model; it sees what they resolve to.
    let named = references::named_entity(message, scope.lookup).await;
    let named_entities = match &named {
        Named::One(entity) => vec![entity.clone()],
        _ => vec![],
    };

    let answers = ask(&instance, request, message, state, &named_entities, attempt).await?;

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

    let asked = |name: &str| intents.get(name) == Some(&true);
    decision.create_worktree = asked("create_worktree");

    log::info!(target: "chat_association", "attempt={} phase=intent select_entity={} create_worktree={} select_worktree={} candidates={}",
        attempt, asked("select_entity"), decision.create_worktree, asked("select_worktree"), scope.candidates.len());

    let mut unresolved = vec![];

    // Creating a worktree never binds an existing one.
    if asked("select_worktree") && !decision.create_worktree {
        match references::named_worktree(message, scope.worktrees) {
            Named::One(worktree) => decision.worktree = Some(worktree),
            Named::Unresolved(reason) => unresolved.push(reason),
            Named::Nothing => unresolved.push(
                "No worktree of this project matches the message. Name it by path, directory name or branch."
                    .into(),
            ),
        }
    }

    if asked("select_entity") || decision.create_worktree {
        match named {
            Named::One(entity) => {
                decision.selection = AssociationSelection::Entity {
                    id: entity.id,
                    title: entity.title,
                    level: entity.level,
                }
            }
            Named::Unresolved(reason) => unresolved.push(reason),
            // A named worktree never implies an entity.
            Named::Nothing if state.current_entity.is_some() || decision.worktree.is_some() => (),
            Named::Nothing if scope.candidates.is_empty() => {
                decision.selection = AssociationSelection::Unknown
            }
            Named::Nothing => {
                decision.selection =
                    choose_entity(&instance, message, scope.candidates, state, attempt).await?
            }
        }
    }

    if !unresolved.is_empty() {
        decision.diagnostic = Some(unresolved.join(" "));
    }

    Ok(decision)
}

async fn choose_entity(
    instance: &HarnessRuntimeInstance,
    message: &str,
    candidates: &[AssociationEntity],
    state: State<'_>,
    attempt: &str,
) -> Result<AssociationSelection, HarnessError> {
    let mut choices = serde_json::Map::new();
    choices.insert("unknown".into(), json!("No identifiable matching entity."));
    for entity in candidates {
        choices.insert(
            entity.id.clone(),
            json!(format!("{}: {}", entity.level_label(), entity.title)),
        );
    }

    let question = json!({
        "type": "choice",
        "instructions": ENTITY_QUESTION,
        "criteria": choices,
    });

    let answers = ask(
        instance,
        BTreeMap::from([("entity".into(), question)]),
        message,
        state,
        &[],
        attempt,
    )
    .await?;
    let choice = answers["entity"]["choice"]
        .as_str()
        .filter(|c| choices.contains_key(*c));
    match choice {
        Some("unknown") => Ok(AssociationSelection::Unknown),
        Some(id) => Ok(candidates
            .iter()
            .find(|t| t.id == id)
            .map(|t| AssociationSelection::Entity {
                id: t.id.clone(),
                title: t.title.clone(),
                level: t.level.clone(),
            })
            .unwrap_or(AssociationSelection::Unknown)),
        None => Err(HarnessError::Operation("Invalid entity choice.".into())),
    }
}

async fn ask(
    instance: &HarnessRuntimeInstance,
    questions: BTreeMap<String, Value>,
    message: &str,
    state: State<'_>,
    named_entities: &[AssociationEntity],
    attempt: &str,
) -> Result<Value, HarnessError> {
    let names: Vec<String> = questions.keys().cloned().collect();
    let request = StructuredInferenceRequest {
        run_id: RunId::new(uuid::Uuid::new_v4().to_string()),
        stream_id: StreamId::new(uuid::Uuid::new_v4().to_string()),
        state: json!({
            "message": message,
            "current_entity": state.current_entity,
            "current_worktree": state.worktree_path,
            "named_entities": named_entities
                .iter()
                .map(|t| json!({ "id": t.id, "short_id": &t.id[..8.min(t.id.len())], "title": t.title, "level": t.level }))
                .collect::<Vec<_>>(),
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
    use super::super::references::tests::ProjectEntities;
    use super::*;
    use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

    const ID: &str = "f6f6bf5e-2ca1-4e50-bcfa-9e08944eaa78";
    static CURRENT: std::sync::LazyLock<AssociationEntity> =
        std::sync::LazyLock::new(|| entities().remove(0));
    /// A project entity absent from the UI cache.
    const UNCACHED: &str = "f17de40f-4496-4d22-8edf-9c2192f4e860";

    fn project() -> ProjectEntities {
        let mut all = entities();
        all.push(AssociationEntity {
            id: UNCACHED.into(),
            title: "Explicit association intents".into(),
            level: crate::types::TaskLevel::Ticket,
        });
        ProjectEntities::new(all)
    }

    fn picked(id: &str) -> AssociationSelection {
        let entity = project().entities.into_iter().find(|t| t.id == id).unwrap();
        AssociationSelection::Entity {
            id: entity.id,
            title: entity.title,
            level: entity.level,
        }
    }

    fn entities() -> Vec<AssociationEntity> {
        vec![
            AssociationEntity {
                id: ID.into(),
                title: "Codex retry status".into(),
                level: crate::types::TaskLevel::Epic,
            },
            AssociationEntity {
                id: "97a3edab-5e4a-40a8-b580-19708657a222".into(),
                title: "Conversation associations".into(),
                level: crate::types::TaskLevel::Task,
            },
            AssociationEntity {
                id: "32fcee8a-20cd-4301-9d8a-748ab49e95d9".into(),
                title: "Ticket association compatibility".into(),
                level: crate::types::TaskLevel::Ticket,
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
        run_in(message, state, intents, choice, &[]).await
    }

    async fn run_in(
        message: &str,
        state: State<'_>,
        intents: Value,
        choice: Option<&str>,
        worktrees: &[AssociationWorktree],
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
            for entity in entities() {
                probabilities[entity.id.as_str()] =
                    json!(if entity.id == choice { 1.0 } else { 0.0 });
            }
            Mock::given(matchers::body_partial_json(
                json!({ "questions": { "entity": {} } }),
            ))
            .respond_with(respond(json!({ "entity": {
                "type": "choice", "choice": choice,
                "probabilities": probabilities, "confidence": 1.0,
            }})))
            .mount(&server)
            .await;
        }

        let lookup = project();
        let scope = Scope {
            candidates: &entities(),
            lookup: &lookup,
            worktrees,
        };

        let decision = decide(&config, message, scope, state, "fixture")
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
            (ResponseTemplate::new(200).set_body_json(json!({ "model": "jev-1.14.0", "answers": {"select_entity": noul(0.9), "create_worktree": noul(0.1)}, "usage": {"input_tokens": 1, "output_tokens": 1} })), entities(), "entity"),
            (ResponseTemplate::new(200).set_body_json(json!({ "model": "jev-1.14.0", "answers": {"select_entity": noul(0.9), "create_worktree": noul(0.1)}, "usage": {"input_tokens": 1, "output_tokens": 1} })), vec![], "keep"),
            (ResponseTemplate::new(503).set_body_string("secret-response"), entities(), "error"),
            (ResponseTemplate::new(200).set_body_string("secret-malformed-json"), entities(), "error"),
            (ResponseTemplate::new(200).set_body_json(json!({"model": "jev-1.14.0", "answers": {}, "usage": {"input_tokens": 1, "output_tokens": 1}})), entities(), "error"),
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
            let lookup = ProjectEntities::new(candidates.clone());
            let scope = Scope { candidates: &candidates, lookup: &lookup, worktrees: &[] };
            let _ = decide(&config, &format!("implement {ID} secret-prompt"), scope, State::default(), &attempt).await;
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
        let lookup = project();
        let scope = Scope {
            candidates: &entities(),
            lookup: &lookup,
            worktrees: &[],
        };

        let error = decide(
            &config,
            "secret-prompt",
            scope,
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
            json!({ "create_worktree": 0.1, "select_entity": 0.2 }),
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
                "current_entity": null,
                "current_worktree": null,
                "named_entities": [],
            })
        );
        let asked = requests[0]["questions"].as_object().unwrap();

        assert!(asked.contains_key("select_entity") && asked.contains_key("create_worktree"));
        assert!(!asked.contains_key("select_worktree"));
    }

    #[tokio::test]
    async fn worktree_request_naming_a_ticket_selects_it_without_a_choice() {
        let message = format!("Let's check the {ID}, is it clear? Let's create a worktree for it");
        let (decision, requests) = run(
            &message,
            State::default(),
            json!({ "create_worktree": 0.9, "select_entity": 0.3, "select_worktree": 0.2 }),
            None,
        )
        .await;

        assert_eq!(decision.selection, picked(ID));
        assert_eq!(decision.worktree, None);
        assert!(decision.create_worktree);
        assert_eq!(requests.len(), 1);
    }

    #[tokio::test]
    async fn unnamed_implementation_request_asks_which_ticket() {
        let (decision, requests) = run(
            "let's implement the retry status entity",
            State::default(),
            json!({ "create_worktree": 0.1, "select_entity": 0.9 }),
            Some(ID),
        )
        .await;

        assert_eq!(decision.selection, picked(ID));
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn known_ticket_only_asks_about_the_worktree() {
        let (decision, requests) = run(
            "ok, let's implement the entity in a new worktree",
            State {
                current_entity: Some(&CURRENT),
                worktree_path: None,
            },
            json!({ "create_worktree": 0.9, "select_worktree": 0.1 }),
            None,
        )
        .await;

        assert_eq!(decision.selection, AssociationSelection::Keep);
        assert!(decision.create_worktree);
        assert_eq!(requests.len(), 1);
        let asked = requests[0]["questions"].as_object().unwrap();

        assert_eq!(
            asked.keys().collect::<Vec<_>>(),
            ["create_worktree", "select_worktree"]
        );

        assert_eq!(requests[0]["state"]["current_entity"], json!(*CURRENT));
    }

    #[tokio::test]
    async fn discussion_and_binding_select_full_and_short_ids_without_implementation() {
        for id in [ID, &ID[..8], UNCACHED, &UNCACHED[..8]] {
            let full = if id.starts_with("f6") { ID } else { UNCACHED };
            for (message, create) in [
                (format!("Let’s look at {id}, then let’s create a worktree for it and implement it there"), 0.9),
                (format!("Create a worktree for the following entity {id}"), 0.9),
                (format!("Let’s tie this conversation with the following entity {id}"), 0.1),
            ] {
                let mut intents = json!({ "create_worktree": create, "select_entity": 0.9 });
                if message.contains("worktree") {
                    intents["select_worktree"] = json!(0.2);
                }

                let (decision, requests) = run(&message, State::default(), intents, None).await;

                assert_eq!(decision.selection, picked(full), "{message}");
                assert_eq!(decision.create_worktree, create > 0.5, "{message}");
                assert_eq!(decision.worktree, None, "{message}");
                assert_eq!(requests.len(), 1, "{message}");
                let asked = requests[0]["questions"].as_object().unwrap();

                assert!(!asked.contains_key("implement"), "{message}");
                // The model sees which entity the ID resolves to, and the ID forms.
                let named = &requests[0]["state"]["named_entities"];

                assert_eq!(named.as_array().unwrap().len(), 1, "{message}");
                assert_eq!(named[0]["id"], json!(full), "{message}");
                assert_eq!(named[0]["short_id"], json!(&full[..8]), "{message}");
                let criteria = &asked["select_entity"]["criteria"];

                assert!(criteria["true"].as_str().unwrap().contains("short ID"));
                assert!(criteria["false"].is_string());
            }
        }
    }

    #[tokio::test]
    async fn explicit_ticket_rebinds_a_complete_association() {
        let state = State {
            current_entity: Some(&CURRENT),
            worktree_path: Some("/p"),
        };

        assert!(questions("what does this function do?", state).is_empty());
        let message = format!("Let’s tie this conversation with the following entity {UNCACHED}");
        let (decision, requests) = run(
            &message,
            state,
            json!({ "create_worktree": 0.1, "select_entity": 0.9 }),
            None,
        )
        .await;

        assert_eq!(decision.selection, picked(UNCACHED));
        assert_eq!(requests.len(), 1);
        // A passing mention without association intent keeps the entity.
        let (decision, _) = run(
            &format!("this resembles {UNCACHED}"),
            state,
            json!({ "create_worktree": 0.1, "select_entity": 0.2 }),
            None,
        )
        .await;

        assert_eq!(decision.selection, AssociationSelection::Keep);
    }

    #[tokio::test]
    async fn existing_worktree_is_tied_without_inventing_a_ticket() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let path = root.join("scratch");
        std::fs::create_dir(&path).unwrap();
        let scratch = AssociationWorktree {
            path: path.to_string_lossy().into(),
            branch: Some("experiment/retry".into()),
        };

        let inventory = [scratch.clone()];
        for state in [
            State::default(),
            State {
                current_entity: Some(&CURRENT),
                worktree_path: Some("/p"),
            },
        ] {
            for name in [scratch.path.as_str(), "scratch", "experiment/retry"] {
                let message = format!("Let’s tie this conversation with the worktree {name}");
                let intents = if state.current_entity.is_some() {
                    json!({ "select_worktree": 0.9 })
                } else {
                    json!({ "create_worktree": 0.1, "select_entity": 0.6, "select_worktree": 0.9 })
                };

                let (decision, requests) =
                    run_in(&message, state, intents, Some(ID), &inventory).await;

                assert_eq!(decision.worktree.as_ref(), Some(&scratch), "{message}");
                assert_eq!(decision.selection, AssociationSelection::Keep, "{message}");
                assert_eq!(decision.diagnostic, None, "{message}");
                assert_eq!(requests.len(), 1, "no entity choice: {message}");
            }
        }
    }

    #[tokio::test]
    async fn unresolved_references_keep_the_association_with_a_diagnostic() {
        let state = State {
            current_entity: Some(&CURRENT),
            worktree_path: Some("/p"),
        };

        for (message, intents) in [
            (
                "tie this conversation with the entity 0123abcd".to_string(),
                json!({ "create_worktree": 0.1, "select_entity": 0.9 }),
            ),
            (
                // Same short ID as a project entity, different full ID: a foreign entity.
                "tie this conversation with the entity f6f6bf5e-0000-4000-8000-000000000000".into(),
                json!({ "create_worktree": 0.1, "select_entity": 0.9 }),
            ),
            (
                "tie this conversation with the worktree /elsewhere/other".into(),
                json!({ "select_worktree": 0.9 }),
            ),
        ] {
            let (decision, _) = run(&message, state, intents, None).await;

            assert_eq!(decision.selection, AssociationSelection::Keep, "{message}");
            assert_eq!(decision.worktree, None, "{message}");
            assert!(decision.diagnostic.is_some(), "{message}");
        }
    }

    #[tokio::test]
    async fn descriptive_choice_and_named_state_distinguish_all_levels() {
        for entity in project().entities {
            let (decision, requests) = run(
                &format!("discuss {}", entity.id),
                State::default(),
                json!({"select_entity": 0.9, "create_worktree": 0.1}),
                None,
            )
            .await;

            assert_eq!(decision.selection, picked(&entity.id));
            assert_eq!(
                requests[0]["state"]["named_entities"][0]["level"],
                json!(entity.level)
            );

            assert_eq!(
                requests[0]["state"]["named_entities"][0]["title"],
                entity.title
            );
        }

        for entity in entities() {
            let (decision, requests) = run(
                &format!("implement the {}", entity.title),
                State::default(),
                json!({"select_entity": 0.9, "create_worktree": 0.1}),
                Some(&entity.id),
            )
            .await;

            assert_eq!(decision.selection, picked(&entity.id));
            for candidate in entities() {
                assert_eq!(
                    requests[1]["questions"]["entity"]["criteria"][&candidate.id],
                    format!("{}: {}", candidate.level_label(), candidate.title)
                );
            }
        }
    }
}
