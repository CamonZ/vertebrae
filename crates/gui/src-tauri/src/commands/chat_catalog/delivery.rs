//! Catalog outbox delivery and dependency ordering.

use super::{error, key, save, Catalog, CommandError, Entry, FIELDS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use vertebrae_sacrum_client::{GraphqlClient, SacrumClientError};

#[cfg(test)]
mod tests;

/// Bounded conflict retries per entry, using the last authoritative revision.
pub(super) const DELIVERY_ATTEMPTS: usize = 2;

#[derive(Deserialize)]
struct Ack {
    status: AckStatus,
    entry: Entry,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AckStatus {
    Accepted,
    Conflict,
}

fn rejection_code(error: &SacrumClientError) -> Option<&str> {
    match error {
        SacrumClientError::GraphqlError { items, .. } => items
            .iter()
            .filter_map(|item| item.code.as_deref())
            .find(|code| matches!(*code, "invalid_payload" | "not_found")),
        _ => None,
    }
}

fn parent_chat_id(desired: &Value) -> Option<&str> {
    desired["parent_chat_id"].as_str()
}

fn is_discussion(desired: &Value) -> bool {
    desired["metadata"]["kind"] == "discussion"
}

pub(super) fn parent_deleted(catalog: &Catalog, project: &str, desired: &Value) -> bool {
    is_discussion(desired)
        && parent_chat_id(desired).is_some_and(|parent| {
            catalog
                .records
                .get(&key(project, parent))
                .is_some_and(|record| record.remote.payload["deleted"] == true)
        })
}

pub(super) fn retry_rejections(catalog: &mut Catalog, project: &str) {
    let prefix = format!("{project}/");
    for (_, record) in catalog
        .records
        .range_mut(prefix.clone()..)
        .take_while(|(id, _)| id.starts_with(&prefix))
    {
        record.rejection_code = None;
    }
}

fn pending_order(catalog: &Catalog, project: &str) -> Vec<String> {
    let prefix = format!("{project}/");
    let mut pending: BTreeMap<_, _> = catalog
        .records
        .iter()
        .filter_map(|(id, record)| {
            let chat = id.strip_prefix(&prefix)?;
            let desired = record.desired.as_ref()?;
            record.rejection_code.is_none().then_some((chat, desired))
        })
        .collect();

    let mut children = BTreeMap::<_, Vec<_>>::new();
    let mut ready = BTreeSet::new();
    for (&chat, desired) in &pending {
        let candidate = (is_discussion(desired), chat);
        if let Some(parent) = parent_chat_id(desired).filter(|p| pending.contains_key(p)) {
            children.entry(parent).or_default().push(candidate);
        } else {
            ready.insert(candidate);
        }
    }

    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let candidate = ready.pop_first().unwrap_or_else(|| {
            // With no ready entry, following parents must reach a cycle.
            let mut chat = *pending.first_key_value().expect("remaining entries").0;
            let mut visited = BTreeSet::new();
            while visited.insert(chat) {
                chat = parent_chat_id(pending[chat]).expect("blocked by pending parent");
            }
            (is_discussion(pending[chat]), chat)
        });
        let (_, chat) = candidate;
        if pending.remove(chat).is_some() {
            ordered.push(key(project, chat));
            ready.extend(children.remove(chat).into_iter().flatten());
        }
    }
    ordered
}

pub(super) fn discard_children(catalog: &mut Catalog, project: &str, parent: &str) {
    let prefix = format!("{project}/");
    catalog.records.retain(|id, record| {
        if id.starts_with(&prefix)
            && record.desired.as_ref().is_some_and(|desired| {
                is_discussion(desired) && parent_chat_id(desired) == Some(parent)
            })
        {
            record.clear_intent();
            // Unacknowledged children have no server record to retain.
            return record.remote.revision > 0;
        }
        true
    });
}

enum Outcome {
    Accepted(Entry),
    Conflict { entry: Entry, mutation_id: String },
    Rejected(String),
}

/// Applies a single server response. Transport errors have no outcome.
fn apply_outcome(catalog: &mut Catalog, project: &str, id: &str, outcome: Outcome) {
    let record = catalog.records.get_mut(id).expect("sent record retained");
    match outcome {
        Outcome::Rejected(code) => {
            record.conflicted = false;
            record.rejection_code = Some(code);
        }
        Outcome::Accepted(entry) => {
            record.clear_intent();
            let deleted = entry.payload["deleted"] == true;
            record.remote = entry;
            if deleted {
                let chat_id = record.remote.chat_id.clone();
                discard_children(catalog, project, &chat_id);
            }
        }
        Outcome::Conflict { entry, mutation_id } => {
            record.conflicted = true;
            record.mutation_id = mutation_id;
            record.remote = entry;
        }
    }
}

/// Send pending entries of one project using the cached remote revision.
pub(super) async fn deliver(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
) -> Result<usize, CommandError> {
    let mutation_query = format!(
        concat!(
            "mutation($p:Uuid4!,$m:Uuid4!,$c:String!,$r:Int!,$n:Uuid4!,$v:Json!){{",
            "putChatCatalog(projectId:$p,installationId:$m,chatId:$c,",
            "expectedRevision:$r,mutationId:$n,payload:$v)",
            "{{status entry{{{fields}}}}}}}"
        ),
        fields = FIELDS,
    );
    let mut sent = 0;

    for id in pending_order(catalog, project) {
        for _ in 0..DELIVERY_ATTEMPTS {
            let Some(record) = catalog.records.get(&id) else {
                break;
            };
            let Some(payload) = &record.desired else {
                break;
            };
            sent += 1;
            let response = client
                .execute::<Ack>(
                    &mutation_query,
                    json!({
                        "p": project,
                        "m": machine,
                        "c": record.remote.chat_id,
                        "r": record.remote.revision,
                        "n": record.mutation_id,
                        "v": payload.to_string()
                    }),
                    "putChatCatalog",
                )
                .await;
            let outcome = match response {
                Ok(ack)
                    if matches!(ack.status, AckStatus::Accepted)
                        || ack.entry.payload["deleted"] == true =>
                {
                    Outcome::Accepted(ack.entry)
                }
                Ok(ack) => Outcome::Conflict {
                    entry: ack.entry,
                    mutation_id: uuid::Uuid::new_v4().to_string(),
                },
                Err(failure) => {
                    Outcome::Rejected(rejection_code(&failure).ok_or_else(error)?.into())
                }
            };
            let rejected = matches!(outcome, Outcome::Rejected(_));
            apply_outcome(catalog, project, &id, outcome);
            let record = &catalog.records[&id];
            if let Some(code) = &record.rejection_code {
                tracing::warn!(
                    project_id = project, chat_id = %record.remote.chat_id, code,
                    "chat_catalog_rejected"
                );
            } else {
                if record.conflicted {
                    tracing::info!(chat_id = %record.remote.chat_id, "chat_catalog_conflict");
                }
                tracing::info!(
                    chat_id = %record.remote.chat_id,
                    revision = record.remote.revision,
                    pending = record.desired.is_some(),
                    imported = record.import_only,
                    "chat_catalog_ack"
                );
            }
            save(path, catalog)?;
            if rejected {
                break;
            }
        }
    }
    Ok(sent)
}
