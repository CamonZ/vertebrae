//! Typed catalog identity, revision reconciliation, and wire operations.

use super::{delivery, error, Catalog, CommandError};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;
use vertebrae_sacrum_client::GraphqlClient;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct ChatId(pub(super) String);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct ThreadId(pub(super) Uuid);

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) enum EntityKey {
    Chat(ChatId),
    Thread(ThreadId),
}

impl EntityKey {
    pub(super) fn chat(id: impl Into<String>) -> Self {
        Self::Chat(ChatId(id.into()))
    }

    pub(super) fn kind(&self) -> EntityKind {
        match self {
            Self::Chat(_) => EntityKind::Chat,
            Self::Thread(_) => EntityKind::Thread,
        }
    }
}

impl std::fmt::Display for EntityKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Chat(id) => id.0.fmt(f),
            Self::Thread(id) => id.0.fmt(f),
        }
    }
}

impl Serialize for EntityKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&format_args!("{}:{self}", self.kind().storage_prefix()))
    }
}

impl<'de> Deserialize<'de> for EntityKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        let (kind, id) = encoded
            .split_once(':')
            .ok_or_else(|| de::Error::custom("missing catalog entity kind"))?;
        match kind {
            "chat" => Ok(Self::chat(id)),
            "thread" => Uuid::parse_str(id)
                .map(|id| Self::Thread(ThreadId(id)))
                .map_err(de::Error::custom),
            _ => Err(de::Error::custom("unknown catalog entity kind")),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Entry {
    pub(super) id: EntityKey,
    pub(super) revision: u64,
    pub(super) payload: Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Remote {
    pub(super) revision: u64,
    pub(super) payload: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub(super) remote: Remote,
    pub(super) desired: Option<Value>,
    pub(super) mutation_id: String,
    #[serde(default)]
    pub(super) conflicted: bool,
    #[serde(default)]
    pub(super) import_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) rejection_code: Option<String>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            remote: Remote::default(),
            desired: None,
            mutation_id: Uuid::new_v4().to_string(),
            conflicted: false,
            import_only: false,
            rejection_code: None,
        }
    }
}

impl Record {
    pub(super) fn visible(&self) -> &Value {
        self.desired.as_ref().unwrap_or(&self.remote.payload)
    }

    pub(super) fn tombstoned(&self) -> bool {
        self.remote.payload["deleted"] == true || self.visible()["deleted"] == true
    }

    pub(super) fn clear_intent(&mut self) {
        self.desired = None;
        self.conflicted = false;
        self.rejection_code = None;
    }
}

pub(super) fn enqueue(catalog: &mut Catalog, project: &str, chat: &str, payload: Value) {
    enqueue_entity(catalog, project, &EntityKey::chat(chat), payload);
}

pub(super) fn enqueue_entity(catalog: &mut Catalog, project: &str, id: &EntityKey, payload: Value) {
    if delivery::parent_deleted(catalog, project, id, &payload) {
        return;
    }

    let record = catalog.upsert(project, id);
    if !record.tombstoned() && record.visible() != &payload {
        record.import_only = false;
        record.conflicted = false;
        record.rejection_code = None;
        record.desired = Some(payload);
        record.mutation_id = Uuid::new_v4().to_string();
    }
}

#[derive(Clone, Copy)]
pub(super) enum MergeSource {
    Observed,
    Acknowledged,
}

pub(super) fn merge(catalog: &mut Catalog, project: &str, entry: Entry) {
    merge_entry(catalog, project, entry, MergeSource::Observed);
}

/// Ignore stale rows and duplicate revisions. A physical delete can arrive
/// with the revision of its last live row and still supersedes that row.
pub(super) fn merge_entry(
    catalog: &mut Catalog,
    project: &str,
    entry: Entry,
    source: MergeSource,
) -> bool {
    let key = entry.id;
    let deleted = entry.payload["deleted"] == true;
    if entry.revision == 0 {
        return false;
    }
    let record = catalog.upsert(project, &key);
    let was_deleted = record.remote.payload["deleted"] == true;
    let should_update = entry.revision > record.remote.revision
        || (entry.revision == record.remote.revision && deleted && !was_deleted);
    if entry.revision < record.remote.revision || (was_deleted && !deleted) {
        return false;
    }

    let matches_intent = record.desired.as_ref() == Some(&entry.payload);
    let clears_intent = record.desired.is_some()
        && (if should_update {
            matches!(source, MergeSource::Acknowledged)
                || deleted
                || record.import_only
                || matches_intent
        } else {
            record.remote.payload == entry.payload
                && (matches!(source, MergeSource::Acknowledged) || matches_intent)
        });
    if clears_intent {
        record.clear_intent();
    }
    if should_update {
        record.remote = Remote {
            revision: entry.revision,
            payload: entry.payload,
        };
    }
    if should_update && deleted && !was_deleted {
        delivery::discard_children(catalog, project, &key);
    }
    should_update || clears_intent
}

#[derive(Clone, Copy)]
pub(super) enum EntityKind {
    Chat,
    Thread,
}

impl EntityKind {
    fn storage_prefix(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Thread => "thread",
        }
    }

    pub(super) fn key(self, raw: String) -> Result<EntityKey, CommandError> {
        match self {
            Self::Chat => Ok(EntityKey::chat(raw)),
            Self::Thread => Uuid::parse_str(&raw)
                .map(|uuid| EntityKey::Thread(ThreadId(uuid)))
                .map_err(|_| error()),
        }
    }

    pub(super) fn mutation_operation(self) -> &'static str {
        match self {
            Self::Chat => "PutChatCatalog",
            Self::Thread => "PutReviewThread",
        }
    }

    pub(super) fn mutation(self) -> &'static str {
        match self {
            Self::Chat => "putChatCatalog",
            Self::Thread => "putReviewThread",
        }
    }

    pub(super) fn field(self) -> &'static str {
        match self {
            Self::Chat => "chatId",
            Self::Thread => "threadId",
        }
    }

    pub(super) fn scalar(self) -> &'static str {
        match self {
            Self::Chat => "String",
            Self::Thread => "Uuid4",
        }
    }

    fn query(self) -> &'static str {
        match self {
            Self::Chat => "chatCatalog",
            Self::Thread => "reviewThreads",
        }
    }

    fn snapshot_query(self, include_completed: bool) -> &'static str {
        match self {
            Self::Chat if !include_completed => concat!(
                "query ChatCatalog($p:Uuid4!,$m:Uuid4!,$after:String){",
                "chatCatalog(projectId:$p,installationId:$m,after:$after,limit:100,includeCompleted:false){",
                "entries{id:chatId revision payload} nextCursor}}"
            ),
            Self::Chat => concat!(
                "query ChatCatalog($p:Uuid4!,$m:Uuid4!,$after:String){",
                "chatCatalog(projectId:$p,installationId:$m,after:$after,limit:100,includeCompleted:true){",
                "entries{id:chatId revision payload} nextCursor}}"
            ),
            Self::Thread => concat!(
                "query ReviewThreads($p:Uuid4!,$m:Uuid4!,$after:Uuid4){",
                "reviewThreads(projectId:$p,installationId:$m,after:$after,limit:100){",
                "entries{id:threadId revision payload} nextCursor}}"
            ),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct WireEntry {
    #[serde(alias = "chatId", alias = "threadId")]
    pub(super) id: String,
    pub(super) revision: u64,
    pub(super) payload: Value,
}

impl WireEntry {
    pub(super) fn into_entry(self, kind: EntityKind) -> Result<Entry, CommandError> {
        Ok(Entry {
            id: kind.key(self.id)?,
            revision: self.revision,
            payload: self.payload,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    entries: Vec<WireEntry>,
    next_cursor: Option<String>,
}

pub(super) async fn fetch_snapshot(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    kind: EntityKind,
) -> Result<BTreeMap<EntityKey, Entry>, CommandError> {
    fetch_pages(client, project, machine, kind, true).await
}

pub(super) async fn fetch_pages(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    kind: EntityKind,
    include_completed: bool,
) -> Result<BTreeMap<EntityKey, Entry>, CommandError> {
    let mut snapshot = BTreeMap::new();
    let mut seen_cursors = BTreeSet::new();
    let mut after: Option<String> = None;
    let query = kind.snapshot_query(include_completed);

    loop {
        let page: Page = client
            .execute(
                query,
                json!({"p": project, "m": machine, "after": after}),
                kind.query(),
            )
            .await
            .map_err(|_| error())?;

        for entry in page.entries {
            let entry = entry.into_entry(kind)?;
            if snapshot.insert(entry.id.clone(), entry).is_some() {
                return Err(error());
            }
        }

        let Some(cursor) = page.next_cursor else {
            return Ok(snapshot);
        };
        if !seen_cursors.insert(cursor.clone()) {
            return Err(error());
        }
        after = Some(cursor);
    }
}
