//! Catalog outbox delivery and dependency ordering.

use super::{
    entity::WireEntry, error, merge_entry, save, Catalog, CommandError, EntityKey, Entry,
    MergeSource,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use uuid::Uuid;
use vertebrae_sacrum_client::{GraphqlClient, SacrumClientError};

#[cfg(test)]
mod tests;

/// Bounded conflict retries per entry, using the last authoritative revision.
pub(super) const DELIVERY_ATTEMPTS: usize = 2;

#[derive(Deserialize)]
struct Ack {
    status: AckStatus,
    entry: Option<WireEntry>,
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

pub(super) fn is_discussion(payload: &Value) -> bool {
    payload["metadata"]["kind"] == "discussion"
}

struct Dependencies {
    chat: Option<EntityKey>,
    thread: Option<EntityKey>,
}

impl Dependencies {
    fn of(id: &EntityKey, payload: &Value) -> Self {
        let chat = payload["parent_chat_id"].as_str().map(EntityKey::chat);
        let thread = if matches!(id, EntityKey::Chat(_)) {
            payload["review_thread_id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| EntityKey::Thread(super::ThreadId(id)))
        } else {
            None
        };
        Self { chat, thread }
    }

    fn iter(&self) -> impl Iterator<Item = &EntityKey> {
        self.chat.iter().chain(&self.thread)
    }
}

fn binds_to_parent(id: &EntityKey, payload: &Value) -> bool {
    matches!(id, EntityKey::Thread(_)) || is_discussion(payload)
}

pub(super) fn parent_deleted(
    catalog: &Catalog,
    project: &str,
    id: &EntityKey,
    desired: &Value,
) -> bool {
    binds_to_parent(id, desired)
        && Dependencies::of(id, desired).iter().any(|parent| {
            catalog
                .record(project, parent)
                .is_some_and(|record| record.remote.payload["deleted"] == true)
        })
}

pub(super) fn retry_rejections(catalog: &mut Catalog, project: &str) {
    if let Some(records) = catalog.projects.get_mut(project) {
        for record in records.values_mut() {
            record.rejection_code = None;
        }
    }
}

fn priority(id: &EntityKey, desired: &Value) -> u8 {
    match id {
        EntityKey::Chat(_) if !is_discussion(desired) => 0,
        EntityKey::Thread(_) => 1,
        EntityKey::Chat(_) => 2,
    }
}

fn pending_order(catalog: &Catalog, project: &str) -> Vec<EntityKey> {
    let mut pending: BTreeMap<_, _> = catalog
        .records(project)
        .filter_map(|(id, record)| {
            let desired = record.desired.as_ref()?;
            record.rejection_code.is_none().then_some((id, desired))
        })
        .collect();

    let mut children = BTreeMap::<_, Vec<_>>::new();
    let mut prerequisites = BTreeMap::<_, BTreeSet<_>>::new();
    let mut ready = BTreeSet::new();
    for (&id, &desired) in &pending {
        for parent in Dependencies::of(id, desired).iter() {
            if let Some((&parent, _)) = pending.get_key_value(parent) {
                children.entry(parent).or_default().push(id);
                prerequisites.entry(id).or_default().insert(parent);
            }
        }

        if !prerequisites.contains_key(id) {
            ready.insert((priority(id, desired), id));
        }
    }

    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let (_, id) = ready.pop_first().unwrap_or_else(|| {
            // Malformed links can form cycles. Break one cycle as the old
            // chat outbox did, letting Sacrum classify the invalid write.
            let mut id = *pending.first_key_value().expect("remaining entries").0;
            let mut visited = BTreeSet::new();
            while visited.insert(id) {
                id = *prerequisites[id]
                    .first()
                    .expect("blocked by pending parent");
            }
            (priority(id, pending[id]), id)
        });

        if pending.remove(id).is_some() {
            ordered.push(id.clone());
            for child in children.remove(id).into_iter().flatten() {
                let parents = prerequisites
                    .get_mut(child)
                    .expect("child depends on parent");
                parents.remove(id);
                if let Some(desired) = pending.get(child) {
                    if parents.is_empty() {
                        ready.insert((priority(child, desired), child));
                    }
                }
            }
        }
    }
    ordered
}

pub(super) fn discard_children(catalog: &mut Catalog, project: &str, parent: &EntityKey) {
    let Some(records) = catalog.projects.get_mut(project) else {
        return;
    };
    // Collect threads first so a main-chat tombstone also removes discussions
    // whose only locally retained link is through a thread.
    let threads: BTreeSet<_> = records
        .iter()
        .filter(|(id, record)| {
            matches!(id, EntityKey::Thread(_))
                && [record.visible(), &record.remote.payload]
                    .iter()
                    .any(|payload| Dependencies::of(id, payload).chat.as_ref() == Some(parent))
        })
        .map(|(id, _)| id.clone())
        .collect();

    let discarded = |id: &EntityKey, desired: &Value| {
        binds_to_parent(id, desired)
            && Dependencies::of(id, desired)
                .iter()
                .any(|dependency| dependency == parent || threads.contains(dependency))
    };

    records.retain(|id, record| {
        if record
            .desired
            .as_ref()
            .is_some_and(|desired| threads.contains(id) || discarded(id, desired))
        {
            record.clear_intent();
            // Unacknowledged children have no server record to retain.
            return record.remote.revision > 0;
        }
        true
    });

    let prefix = format!("{project}/");
    catalog.migration.pending.retain(|id, desired| {
        id.strip_prefix(&prefix)
            .is_none_or(|id| !discarded(&EntityKey::chat(id), desired))
    });
}

enum Outcome {
    Accepted(Entry),
    Conflict(Option<Entry>),
    Rejected(String),
}

fn apply_outcome(catalog: &mut Catalog, project: &str, id: &EntityKey, outcome: Outcome) {
    match outcome {
        Outcome::Accepted(entry) => {
            merge_entry(catalog, project, entry, MergeSource::Acknowledged);
        }
        Outcome::Conflict(entry) => {
            let has_authoritative_revision = entry.is_some();
            if let Some(entry) = entry {
                merge_entry(catalog, project, entry, MergeSource::Observed);
            }
            let record = catalog.upsert(project, id);
            if record.desired.is_some() {
                record.conflicted = true;
                if has_authoritative_revision {
                    record.mutation_id = Uuid::new_v4().to_string();
                }
            }
        }
        Outcome::Rejected(code) => {
            let record = catalog.upsert(project, id);
            record.conflicted = false;
            record.rejection_code = Some(code);
        }
    }
}

fn blocked(catalog: &Catalog, project: &str, id: &EntityKey, payload: &Value) -> bool {
    if parent_deleted(catalog, project, id, payload) {
        return true;
    }

    let dependencies = Dependencies::of(id, payload);
    let required = match id {
        EntityKey::Thread(_) => dependencies.chat,
        EntityKey::Chat(_) => dependencies.thread,
    };
    required.is_some_and(|parent| {
        catalog
            .record(project, &parent)
            .is_some_and(|record| record.remote.revision == 0 && record.desired.is_some())
    })
}

/// Send pending entries of one project using the cached server revisions.
pub(super) async fn deliver(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
) -> Result<usize, CommandError> {
    let mut sent = 0;
    for id in pending_order(catalog, project) {
        let kind = id.kind();
        let query = format!(
            "mutation {operation}($p:Uuid4!,$m:Uuid4!,$c:{scalar}!,$r:Int!,$n:Uuid4!,$v:Json!){{{mutation}(projectId:$p,installationId:$m,{field}:$c,expectedRevision:$r,mutationId:$n,payload:$v){{status entry{{id:{field} revision payload}}}}}}",
            operation = kind.mutation_operation(),
            scalar = kind.scalar(),
            mutation = kind.mutation(),
            field = kind.field(),
        );

        for _ in 0..DELIVERY_ATTEMPTS {
            let Some(record) = catalog.record(project, &id) else {
                break;
            };
            let Some(payload) = &record.desired else {
                break;
            };
            if blocked(catalog, project, &id, payload) {
                break;
            }

            sent += 1;
            let response = client.execute::<Ack>(
                &query,
                json!({
                    "p": project, "m": machine, "c": id.to_string(),
                    "r": record.remote.revision, "n": record.mutation_id, "v": payload.to_string()
                }),
                kind.mutation(),
            ).await;

            let outcome = match response {
                Ok(ack) => {
                    let entry = ack.entry.map(|entry| entry.into_entry(kind)).transpose()?;
                    if entry.as_ref().is_some_and(|entry| {
                        entry.id != id || entry.revision < record.remote.revision
                    }) {
                        return Err(error());
                    }
                    match ack.status {
                        AckStatus::Accepted => Outcome::Accepted(entry.ok_or_else(error)?),
                        AckStatus::Conflict => Outcome::Conflict(entry),
                    }
                }
                Err(failure) => {
                    Outcome::Rejected(rejection_code(&failure).ok_or_else(error)?.into())
                }
            };

            // A conflict with no current row changes no authoritative state.
            // Preserve the intent for later reconciliation without retrying
            // the same expected revision in this pass.
            let stop = matches!(outcome, Outcome::Rejected(_) | Outcome::Conflict(None));
            apply_outcome(catalog, project, &id, outcome);

            let record = catalog.record(project, &id).expect("sent record retained");
            if let Some(code) = &record.rejection_code {
                tracing::warn!(project_id = project, entity_id = %id, kind = kind.field(), code, "chat_catalog_rejected");
            } else {
                if record.conflicted {
                    tracing::info!(entity_id = %id, kind = kind.field(), "chat_catalog_conflict");
                }
                tracing::info!(
                    chat_id = %id,
                    revision = record.remote.revision,
                    pending = record.desired.is_some(),
                    imported = record.import_only,
                    "chat_catalog_ack"
                );
            }

            save(path, catalog)?;
            if stop {
                break;
            }
        }
    }
    Ok(sent)
}
