//! Associates a local chat with a ticket and Git worktree. Prototype: the
//! decision model reads only new user messages; tool events only yield worktrees.
mod inference;
mod inventory;

use super::CommandError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct AssociationTicket {
    pub id: String,
    pub title: String,
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
    /// Eligible tickets read from the React Query cache (user events only).
    pub candidates: Vec<AssociationTicket>,
    pub candidate_project_root: Option<String>,
    /// Current association; only its missing parts are asked about.
    pub ticket_id: Option<String>,
    pub worktree_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssociationSelection {
    Keep,
    Unknown,
    Ticket { id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AssociationResult {
    pub selection: AssociationSelection,
    /// User events: the inventory now, before any requested worktree exists.
    /// Tool events: the worktrees the event touched.
    pub worktrees: Vec<AssociationWorktree>,
    /// The user asked to create a worktree; a later tool event will reveal it.
    pub create_worktree: bool,
    /// Set when the decision could not run; the caller keeps its association.
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
    log::info!(target: "chat_association", "attempt={} phase=start event={:?} text_bytes={} candidates={} has_ticket={} has_worktree={}",
        attempt, input.event_kind, input.text.len(), input.candidates.len(), input.ticket_id.is_some(), input.worktree_path.is_some());
    let outcome = resolve(input, &attempt).await;
    match &outcome {
        Ok(result) => {
            log::info!(target: "chat_association", "attempt={} phase=finish elapsed_ms={} selection={} worktrees={} create_worktree={} diagnostic={:?}",
            attempt, started.elapsed().as_millis(), match result.selection { AssociationSelection::Keep => "keep", AssociationSelection::Unknown => "unknown", AssociationSelection::Ticket { .. } => "ticket" },
            result.worktrees.len(), result.create_worktree, result.diagnostic)
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
            "Too many cached tickets for a single decision (maximum 1024).",
        ));
    }
    log::info!(target: "chat_association", "attempt={} phase=context project={} worktree={} cache={}", attempt, fingerprint(&input.project_root), input.worktree_path.as_deref().map(fingerprint).unwrap_or_default(), input.candidate_project_root.as_deref().map(fingerprint).unwrap_or_default());
    let blocking = input.clone();
    let scope = tokio::task::spawn_blocking(move || inventory::scope(&blocking.project_root))
        .await
        .map_err(|_| invalid("Could not inspect the conversation workspace."))??;
    log::info!(target: "chat_association", "attempt={} phase=inventory worktrees={} path_fingerprints={:?}", attempt, scope.worktrees.len(), scope.worktrees.iter().take(8).map(|w| fingerprint(&w.path)).collect::<Vec<_>>());
    let mut result = AssociationResult {
        selection: AssociationSelection::Keep,
        worktrees: vec![],
        create_worktree: false,
        diagnostic: None,
    };
    if input.event_kind == AssociationEventKind::Tool {
        result.worktrees =
            inventory::observed_worktrees(&input.text, &scope.root, &scope.worktrees);
        return Ok(result);
    }
    if !scope.config.decision_model.enabled {
        result.diagnostic = Some("Decision model disabled in Settings.".into());
        return Ok(result);
    }
    // Cached candidates count only for this conversation's own project.
    let cache_root = input
        .candidate_project_root
        .as_deref()
        .and_then(|root| std::fs::canonicalize(root).ok());
    if !cache_root.is_some_and(|root| scope.worktrees.iter().any(|w| Path::new(&w.path) == root)) {
        result.diagnostic = Some("Ticket cache does not belong to this project.".into());
        return Ok(result);
    }
    result.worktrees = scope.worktrees;
    let state = inference::State {
        ticket_id: input.ticket_id.as_deref(),
        worktree_path: input.worktree_path.as_deref(),
    };
    match inference::decide(
        &scope.config,
        &input.text,
        &input.candidates,
        state,
        attempt,
    )
    .await
    {
        Ok(decision) => {
            result.selection = decision.selection;
            result.create_worktree = decision.create_worktree;
        }
        Err(error) => result.diagnostic = Some(inference::diagnostic(&error)),
    }
    Ok(result)
}

/// Stable only within this binary's hash implementation; paths never enter logs.
fn fingerprint(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}
