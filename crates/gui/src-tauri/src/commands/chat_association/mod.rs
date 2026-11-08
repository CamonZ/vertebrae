//! Associates a local chat with an entity and Git worktree. The decision model
//! reads only new user messages; tool events only yield worktrees. Explicit
//! entity IDs and worktree names resolve only within the conversation's project.
mod inference;
mod inventory;
mod references;

use super::CommandError;
use crate::types::TaskLevel;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct AssociationEntity {
    pub id: String,
    pub title: String,
    pub level: TaskLevel,
}

impl AssociationEntity {
    fn level_label(&self) -> &'static str {
        match self.level {
            TaskLevel::Epic => "epic",
            TaskLevel::Ticket => "ticket",
            TaskLevel::Task => "task",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct AssociationWorktree {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssociationEventKind {
    User,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AssociationInput {
    pub attempt_id: Option<String>,
    pub project_root: String,
    pub event_kind: AssociationEventKind,
    pub text: String,
    /// Eligible entities read from the React Query cache (user events only).
    pub candidates: Vec<AssociationEntity>,
    pub candidate_project_root: Option<String>,
    /// Current association; only its missing parts are asked about.
    pub entity: Option<AssociationEntity>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssociationSelection {
    Keep,
    Unknown,
    Entity {
        id: String,
        title: String,
        level: TaskLevel,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AssociationResult {
    pub selection: AssociationSelection,
    /// An existing project worktree the user explicitly tied to the conversation.
    pub worktree: Option<AssociationWorktree>,
    /// User events: the inventory now, before any requested worktree exists.
    /// Tool events: the worktrees the event touched.
    pub worktrees: Vec<AssociationWorktree>,
    /// The user asked to create a worktree; a later tool event will reveal it.
    pub create_worktree: bool,
    /// Set when the decision could not run or an explicit reference did not
    /// resolve; nothing is guessed and the rest of the result still applies.
    pub diagnostic: Option<String>,
}

pub(super) fn invalid(message: &str) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_chat_association(
    input: AssociationInput,
) -> Result<AssociationResult, CommandError> {
    let attempt = input
        .attempt_id
        .as_deref()
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string();
    let started = std::time::Instant::now();
    log::info!(target: "chat_association", "attempt={} phase=start event={:?} text_bytes={} candidates={} has_entity={} has_worktree={}",
        attempt, input.event_kind, input.text.len(), input.candidates.len(), input.entity.is_some(), input.worktree_path.is_some());
    let outcome = resolve(input, &attempt).await;
    match &outcome {
        Ok(result) => {
            log::info!(target: "chat_association", "attempt={} phase=finish elapsed_ms={} selection={} worktree={} worktrees={} create_worktree={} diagnostic={}",
            attempt, started.elapsed().as_millis(), match result.selection { AssociationSelection::Keep => "keep", AssociationSelection::Unknown => "unknown", AssociationSelection::Entity { .. } => "entity" },
            result.worktree.is_some(), result.worktrees.len(), result.create_worktree, result.diagnostic.is_some())
        }
        Err(error) => {
            log::info!(target: "chat_association", "attempt={} phase=finish elapsed_ms={} status=error reason={}", attempt, started.elapsed().as_millis(), error.message)
        }
    }
    outcome
}

async fn resolve(
    input: AssociationInput,
    attempt: &str,
) -> Result<AssociationResult, CommandError> {
    if input.text.chars().count() > 24_000 {
        return Err(invalid("The association message is too large."));
    }

    if input.candidates.len() > 1_024 {
        return Err(invalid(
            "Too many cached entities for a single decision (maximum 1024).",
        ));
    }
    log::info!(target: "chat_association", "attempt={} phase=context project={} worktree={} cache={}", attempt, fingerprint(&input.project_root), input.worktree_path.as_deref().map(fingerprint).unwrap_or_default(), input.candidate_project_root.as_deref().map(fingerprint).unwrap_or_default());
    let mut result = AssociationResult {
        selection: AssociationSelection::Keep,
        worktree: None,
        worktrees: vec![],
        create_worktree: false,
        diagnostic: None,
    };

    let state = inference::State {
        current_entity: input.entity.as_ref(),
        worktree_path: input.worktree_path.as_deref(),
    };

    if input.event_kind == AssociationEventKind::User
        && inference::questions(&input.text, state).is_empty()
    {
        return Ok(result);
    }

    let blocking = input.clone();
    let scope = tokio::task::spawn_blocking(move || inventory::scope(&blocking.project_root))
        .await
        .map_err(|_| invalid("Could not inspect the conversation workspace."))??;
    log::info!(target: "chat_association", "attempt={} phase=inventory worktrees={} path_fingerprints={:?}", attempt, scope.worktrees.len(), scope.worktrees.iter().take(8).map(|w| fingerprint(&w.path)).collect::<Vec<_>>());
    if input.event_kind == AssociationEventKind::Tool {
        result.worktrees =
            inventory::observed_worktrees(&input.text, &scope.root, &scope.worktrees);
        return Ok(result);
    }

    if !scope.config.decision_model.enabled {
        result.diagnostic = Some("Decision model disabled in Settings.".into());
        return Ok(result);
    }
    // Cached candidates count only for this conversation's own project;
    // explicit IDs still resolve through the project's own backend.
    let cache_root = input
        .candidate_project_root
        .as_deref()
        .and_then(|root| std::fs::canonicalize(root).ok());
    let own_cache = cache_root.is_some_and(|root| scope.owns_cache_root(&root));
    let candidates = if own_cache {
        &input.candidates[..]
    } else {
        &[]
    };

    let lookup = ProjectEntities {
        project: scope.project.clone(),
    };

    let decision = inference::decide(
        &scope.config,
        &input.text,
        inference::Scope {
            candidates,
            lookup: &lookup,
            worktrees: &scope.worktrees,
        },
        state,
        attempt,
    )
    .await;
    result.worktrees = scope.worktrees;
    match decision {
        Ok(decision) => {
            result.diagnostic = decision.diagnostic.or_else(|| {
                (!own_cache && decision.selection == AssociationSelection::Unknown)
                    .then(|| "Entity cache does not belong to this project.".into())
            });
            result.selection = decision.selection;
            result.worktree = decision.worktree;
            result.create_worktree = decision.create_worktree;
        }
        Err(error) => result.diagnostic = Some(inference::diagnostic(&error)),
    }

    Ok(result)
}

/// Entities of the conversation's registered project, independent of the
/// project currently selected in the window.
struct ProjectEntities {
    project: String,
}

#[async_trait::async_trait]
impl references::EntityLookup for ProjectEntities {
    async fn by_prefix(&self, prefix: &str) -> Result<Option<AssociationEntity>, ()> {
        let config = vertebrae_sacrum_client::SacrumConfig::load_for_project(&self.project)
            .map_err(|_| ())?;
        lookup_project_entity(config, prefix).await
    }
}

async fn lookup_project_entity(
    config: vertebrae_sacrum_client::SacrumConfig,
    reference: &str,
) -> Result<Option<AssociationEntity>, ()> {
    let project_id = config.project_id.clone();
    let services = vertebrae_sacrum_client::from_sacrum(std::sync::Arc::new(
        vertebrae_sacrum_client::GraphqlClient::new(config),
    ));
    // Sacrum accepts only 1-8 hex characters in resolveShortId. Full UUIDs
    // use the direct read, then verify ownership before exposing any metadata.
    let id = if uuid::Uuid::parse_str(reference).is_ok() {
        reference.to_string()
    } else {
        match services.tasks().resolve_short_id(&reference[..8]).await {
            Ok(id) => id,
            Err(vertebrae_core::ServiceError::TaskNotFound { .. }) => return Ok(None),
            Err(_) => return Err(()),
        }
    };

    let task = match services.tasks().get_task_summary(&id).await {
        Ok(task) => task,
        Err(vertebrae_core::ServiceError::TaskNotFound { .. }) => return Ok(None),
        Err(_) => return Err(()),
    };

    Ok((task.project_id.as_deref() == Some(project_id.as_str())
        && task.id.to_lowercase().starts_with(reference)
        && eligible_entity(&task))
    .then(|| AssociationEntity {
        id: task.id,
        title: task.title.chars().take(160).collect(),
        level: task.level.into(),
    }))
}

/// Stable only within this binary's hash implementation; paths never enter logs.
fn fingerprint(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

/// Selection eligibility is identical for epic, ticket and task entities.
fn eligible_entity(task: &vertebrae_core::Task) -> bool {
    !task.archived
        && task.completed_at.is_none()
        && task.step_type != Some(vertebrae_core::StepType::Finish)
}

/// Manual correction uses the same project-scoped eligible-entity lookup,
/// without asking the decision model to reinterpret the user's exact ID.
#[tauri::command]
#[specta::specta]
pub async fn resolve_chat_association_entity(
    project_root: String,
    id: String,
) -> Result<AssociationEntity, CommandError> {
    use references::Named;
    let id = id.trim().to_lowercase();
    if references::entity_tokens(&id) != [id.clone()] {
        return Err(invalid(
            "Enter a full UUID or a unique short ID (8+ characters).",
        ));
    }

    let scope = tokio::task::spawn_blocking(move || inventory::scope(&project_root))
        .await
        .map_err(|_| invalid("Could not inspect the conversation workspace."))??;
    let lookup = ProjectEntities {
        project: scope.project,
    };

    match references::named_entity(&id, &lookup).await {
        Named::One(entity) => Ok(entity),
        Named::Unresolved(reason) => Err(invalid(&reason)),
        Named::Nothing => Err(invalid(
            "No eligible entity in this project matches that ID.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eligibility_excludes_archived_completed_and_finish_at_every_level() {
        for level in [
            vertebrae_core::Level::Epic,
            vertebrae_core::Level::Ticket,
            vertebrae_core::Level::Task,
        ] {
            let mut task = vertebrae_core::Task::new("Association", level);

            assert!(eligible_entity(&task));
            task.archived = true;

            assert!(!eligible_entity(&task));
            task.archived = false;
            task.completed_at = Some(chrono::Utc::now());

            assert!(!eligible_entity(&task));
            task.completed_at = None;
            task.step_type = Some(vertebrae_core::StepType::Finish);

            assert!(!eligible_entity(&task));
        }
    }

    #[tokio::test]
    async fn backend_full_and_short_ids_obey_the_real_wire_contract_and_project_scope() {
        use serde_json::{json, Value};
        use wiremock::{matchers::body_string_contains, Mock, MockServer, ResponseTemplate};
        const ID: &str = "f17de40f-4496-4d22-8edf-9c2192f4e860";
        for level in ["epic", "ticket", "task"] {
            for owner in ["own-project", "foreign-project"] {
                let server = MockServer::start().await;
                Mock::given(body_string_contains("GetTaskSummary"))
                    .respond_with(ResponseTemplate::new(200).set_body_json(
                        json!({"data": {"task": {
                            "id": ID, "project_id": owner, "title": "Entity title", "level": level,
                            "archived": false, "tags": [], "completed_at": null,
                        }}}),
                    ))
                    .mount(&server)
                    .await;
                Mock::given(body_string_contains("ListWorkflows"))
                    .respond_with(
                        ResponseTemplate::new(200)
                            .set_body_json(json!({"data": {"workflows": []}})),
                    )
                    .mount(&server)
                    .await;
                Mock::given(body_string_contains("ResolveShortId"))
                    .respond_with(
                        ResponseTemplate::new(200)
                            .set_body_json(json!({"data": {"resolveShortId": {"id": ID}}})),
                    )
                    .mount(&server)
                    .await;
                for reference in [ID, &ID[..8]] {
                    let config = vertebrae_sacrum_client::SacrumConfig::new(
                        server.uri(),
                        "fixture-token".into(),
                        "own-project".into(),
                    );
                    let result = lookup_project_entity(config, reference).await.unwrap();
                    if owner == "own-project" {
                        let entity = result.unwrap();

                        assert_eq!(entity.id, ID);
                        assert_eq!(entity.level_label(), level);
                    } else {
                        assert_eq!(result, None);
                    }
                }

                let bodies = server
                    .received_requests()
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
                    .collect::<Vec<_>>();
                let prefix_reads = bodies
                    .iter()
                    .filter(|body| body["query"].as_str().unwrap().contains("ResolveShortId"))
                    .collect::<Vec<_>>();

                assert_eq!(
                    prefix_reads.len(),
                    1,
                    "full UUID must bypass prefix resolver"
                );

                assert_eq!(prefix_reads[0]["variables"]["prefix"], &ID[..8]);
                assert_eq!(prefix_reads[0]["variables"]["project_id"], "own-project");
            }
        }
    }
}
