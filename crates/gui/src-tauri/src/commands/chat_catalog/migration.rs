//! Versioned retirement of legacy catalog copies after independent backend read-back.
//!
//! Worktree annotations are deliberately excluded: their patches and file metadata
//! remain local. Unknown annotation kinds are retained rather than guessed at.

use super::*;
use std::collections::BTreeSet;

pub(super) const VERSION: u32 = 1;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Migration {
    #[serde(default)]
    pub pending: BTreeMap<String, Value>,
    #[serde(default)]
    pub verified: BTreeSet<String>,
    #[serde(default)]
    pub version: u32,
}

#[derive(Default, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct AnnotationInventory {
    local_only: usize,
    unsupported: usize,
    malformed: usize,
    #[serde(default)]
    unavailable: bool,
}

impl AnnotationInventory {
    pub(super) fn unavailable() -> Self {
        Self {
            unavailable: true,
            ..Self::default()
        }
    }
}

/// Inventory records without discarding damaged lines or inventing historical
/// classifier provenance. The only current producer is the local Git recorder.
pub(super) fn inventory_annotations(
    root: &Path,
    chat: &str,
) -> Result<AnnotationInventory, CommandError> {
    use std::io::{BufRead, BufReader, Read};

    crate::local_chat::annotations::validate_session_id(chat).map_err(|_| error())?;
    let path = root
        .join("local-chat-annotations")
        .join(format!("{chat}.jsonl"));
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AnnotationInventory::default())
        }
        Err(_) => return Err(error()),
    };
    let mut reader = BufReader::new(file);
    let mut inventory = AnnotationInventory::default();
    loop {
        let mut line = Vec::new();
        let limit = crate::local_chat::annotations::MAX_ANNOTATION_LINE_BYTES;
        let length = reader
            .by_ref()
            .take((limit + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| error())?;
        if length == 0 {
            break;
        }
        if length > limit {
            inventory.malformed += 1;
            // Preserve the entire source; there is no safe cleanup for this record.
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<crate::local_chat::LocalChatAnnotation>(&line) {
            Ok(entry) if entry.session_id == chat && !entry.tool_id.is_empty() => {
                if entry.kind == "worktree_delta" {
                    inventory.local_only += 1;
                } else {
                    inventory.unsupported += 1;
                }
            }
            _ => inventory.malformed += 1,
        }
    }
    Ok(inventory)
}

/// Only the local portion of a session. Backend hydration supplies its summary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sidecar {
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discussion: Option<super::super::local_chat::LocalChatDiscussionBinding>,
    pub association: Option<Value>,
    pub gate: Option<crate::local_chat::LocalChatGateBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steering_turn_ids: Option<BTreeMap<String, String>>,
}

impl Sidecar {
    pub fn from_session(session: &LocalChatSessionIndexEntry) -> Self {
        let mut association = session.association.clone();
        if let Some(fields) = association.as_mut().and_then(Value::as_object_mut) {
            for field in ["ticketId", "ticketTitle", "entityLevel"] {
                fields.remove(field);
            }
        }

        Self {
            project_path: session.project_path.clone(),
            discussion: session.discussion_binding.clone(),
            association,
            gate: session.gate.clone(),
            steering_turn_ids: session.steering_turn_ids.clone(),
        }
    }
}

pub(super) fn queue(catalog: &mut Catalog, id: &str, payload: Value) {
    if !catalog.migration.verified.contains(id) {
        catalog.migration.pending.insert(id.into(), payload);
    }
}

/// A mutation acknowledgement alone cannot retire a source file. Compare it
/// with an independently fetched, complete backend snapshot before checkpointing.
pub(super) fn reconcile(
    catalog: &mut Catalog,
    project: &str,
    snapshot: &BTreeMap<EntityKey, Entry>,
) {
    let prefix = format!("{project}/");
    let verified: Vec<_> = catalog
        .migration
        .pending
        .iter()
        .filter(|(id, _)| id.starts_with(&prefix))
        .filter_map(|(id, expected)| {
            let (_, chat) = id.split_once('/')?;
            let entity = EntityKey::chat(chat);
            let record = catalog.record(project, &entity)?;
            let remote = snapshot.get(&entity)?;
            if record.desired.is_some()
                || record.conflicted
                || remote.revision < record.remote.revision
            {
                return None;
            }
            // A terminal backend tombstone must win over any legacy import.
            if remote.payload["deleted"] == true || remote.payload == *expected {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect();

    for id in verified {
        catalog.migration.pending.remove(&id);
        catalog.migration.verified.insert(id);
    }
    catalog.migration.version = VERSION;
}

pub(super) fn can_retire(catalog: &Catalog, session: &LocalChatSessionIndexEntry) -> bool {
    catalog.migration.version == VERSION
        && catalog.sidecars.iter().any(|(id, sidecar)| {
            id.split_once('/').is_some_and(|(project, chat)| {
                chat == session.id
                    && catalog.chat(project, chat).is_some()
                    && catalog.migration.verified.contains(id)
                    && *sidecar == Sidecar::from_session(session)
            })
        })
}

pub(super) async fn finish(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
    root: &Path,
    recovered: Option<&BTreeMap<EntityKey, Entry>>,
) -> Result<(), CommandError> {
    let prefix = format!("{project}/");
    if catalog
        .migration
        .pending
        .keys()
        .any(|id| id.starts_with(&prefix))
    {
        let fetched;
        let snapshot = match recovered {
            Some(snapshot) => snapshot,
            None => {
                fetched = fetch_snapshot(client, project, machine, EntityKind::Chat).await?;
                for entry in fetched.values() {
                    merge(catalog, project, entry.clone());
                }
                &fetched
            }
        };
        reconcile(catalog, project, snapshot);
        // Commit local-only sidecars and the verified checkpoint before cleanup.
        save(path, catalog)?;
    }

    // Also retry cleanup after a crash between checkpointing and file removal.
    cleanup_index(root, catalog)
}

pub(super) fn cleanup_index(root: &Path, catalog: &Catalog) -> Result<(), CommandError> {
    let path = root.join("local-chat-session-index.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(error()),
    };
    let mut document: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
    if document.as_object().is_some_and(|fields| {
        fields
            .keys()
            .any(|key| key != "version" && key != "sessions")
    }) {
        return Err(error());
    }
    let rows = if document.is_array() {
        document.as_array_mut()
    } else if document["version"] == 1 {
        document.get_mut("sessions").and_then(Value::as_array_mut)
    } else {
        return Err(error());
    }
    .ok_or_else(error)?;

    let original_count = rows.len();
    rows.retain(|raw| {
        let Ok(session) = serde_json::from_value::<LocalChatSessionIndexEntry>(raw.clone()) else {
            return true;
        };
        let known = serde_json::to_value(&session).expect("session serialization");
        // A newer writer may have stored fields this client cannot preserve.
        let unknown_fields = raw
            .as_object()
            .is_none_or(|fields| fields.keys().any(|key| known.get(key).is_none()));
        unknown_fields || !can_retire(catalog, &session)
    });

    if rows.len() == original_count {
        return Ok(());
    }
    if rows.is_empty() {
        fs::remove_file(&path).map_err(|_| error())?;
        fs::File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error())
    } else {
        durable_write(&path, &serde_json::to_vec(&document).map_err(|_| error())?)
    }
}

#[cfg(test)]
mod tests;
