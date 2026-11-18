//! Durable machine-scoped catalog synchronization. Only an explicit projection
//! crosses the network; provider transcripts and association bookkeeping stay local.

use super::{
    local_chat::{LocalChatActivityStatus, LocalChatSessionIndexEntry},
    AppState, CommandError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
use tokio::sync::Mutex;
use uuid::Uuid;
use vertebrae_sacrum_client::GraphqlClient;

mod delivery;
mod entity;
mod migration;
mod review_threads;
mod storage;
pub(crate) use review_threads::*;

use delivery::deliver;
use entity::{
    enqueue, enqueue_entity, fetch_snapshot, merge, merge_entry, EntityKey, EntityKind, Entry,
    MergeSource, Record, ThreadId,
};

static SERIAL: Mutex<()> = Mutex::const_new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<EntityKey, Record>>,
    unmapped: Vec<String>,
    #[serde(default)]
    sidecars: BTreeMap<String, migration::Sidecar>,
    #[serde(default)]
    migration: migration::Migration,
    #[serde(default)]
    annotations: BTreeMap<String, migration::AnnotationInventory>,
}

impl Catalog {
    fn records(&self, project: &str) -> impl Iterator<Item = (&EntityKey, &Record)> {
        self.projects
            .get(project)
            .into_iter()
            .flat_map(|records| records.iter())
    }

    fn record(&self, project: &str, id: &EntityKey) -> Option<&Record> {
        self.projects.get(project)?.get(id)
    }

    fn record_mut(&mut self, project: &str, id: &EntityKey) -> Option<&mut Record> {
        self.projects.get_mut(project)?.get_mut(id)
    }

    fn upsert(&mut self, project: &str, id: &EntityKey) -> &mut Record {
        self.projects
            .entry(project.into())
            .or_default()
            .entry(id.clone())
            .or_default()
    }

    fn chat(&self, project: &str, id: &str) -> Option<&Record> {
        self.record(project, &EntityKey::chat(id))
    }
}

fn error() -> CommandError {
    CommandError {
        message: "Chat catalog synchronization unavailable; local changes are retained.".into(),
    }
}

fn key(project: &str, chat: &str) -> String {
    format!("{project}/{chat}")
}

/// The GUI serializes catalog writers with SERIAL and index writers with INDEX_SERIAL.
/// The application data directory is trusted and owned by this user.
fn durable_write(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    use std::io::Write;

    let root = path.parent().ok_or_else(error)?;
    let temporary = root.join(format!(".chat-catalog-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| error())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| error())?;
        fs::rename(&temporary, path).map_err(|_| error())?;
        fs::File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn lock_file(root: &Path, name: &str) -> Result<fs::File, CommandError> {
    use fs2::FileExt;

    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join(name)).map_err(|_| error())?;
    file.try_lock_exclusive().map_err(|_| error())?;
    Ok(file)
}

pub(super) fn lock_index(path: &Path) -> Result<fs::File, CommandError> {
    lock_file(path.parent().ok_or_else(error)?, ".chat-index.lock")
}

fn save(path: &Path, state: &Catalog) -> Result<(), CommandError> {
    durable_write(path, &storage::encode(state)?)?;

    let mut projects: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut pending = Vec::new();
    let mut conflicted = Vec::new();
    let mut rejected = Vec::new();

    let mut pending_threads = Vec::new();
    let mut conflicted_threads = Vec::new();
    for (project, records) in &state.projects {
        for (id, record) in records {
            let (field, pending_list, conflicted_list) = match id {
                EntityKey::Chat(chat) => {
                    projects.entry(project.clone()).or_default().push(json!({
                        "chat_id": chat.0,
                        "revision": record.remote.revision,
                        "payload": record.visible()
                    }));
                    ("chat_id", &mut pending, &mut conflicted)
                }
                EntityKey::Thread(_) => {
                    ("thread_id", &mut pending_threads, &mut conflicted_threads)
                }
            };
            if record.desired.is_some() {
                pending_list.push(id.to_string());
            }
            if record.conflicted {
                conflicted_list.push(id.to_string());
            }
            if let Some(code) = &record.rejection_code {
                rejected
                    .push(json!({"project_id": project, (field): id.to_string(), "code": code}));
            }
        }
    }

    let projects: Vec<_> = projects
        .into_iter()
        .map(|(project_id, entries)| json!({"project_id": project_id, "entries": entries}))
        .collect();
    let expected = json!({
        "installation_id": installation(path.parent().ok_or_else(error)?)?,
        "projects": projects,
        "pending": pending,
        "conflicted": conflicted,
        "pending_threads": pending_threads,
        "conflicted_threads": conflicted_threads,
        "rejected": rejected,
        "unmapped": state.unmapped,
        "migration_version": state.migration.version,
        "migration_pending": state.migration.pending.keys().collect::<Vec<_>>(),
        "migration_verified": state.migration.verified,
        "annotations_retained": state.annotations
    });

    let expected_path = path.with_extension("expected.json");
    durable_write(
        &expected_path,
        &serde_json::to_vec(&expected).map_err(|_| error())?,
    )
}

fn load(path: &Path) -> Result<Catalog, CommandError> {
    match fs::read(path) {
        Ok(bytes) => storage::decode(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Catalog::default()),
        Err(_) => Err(error()),
    }
}

fn installation(root: &Path) -> Result<String, CommandError> {
    vertebrae_installer::installation_id_in(root).map_err(|_| error())
}

/// Keep this allowlist independent of the session struct's future fields.
fn projection(session: &LocalChatSessionIndexEntry) -> Value {
    let value = serde_json::to_value(session).expect("session serialization");
    let mut metadata = serde_json::Map::new();

    for field in [
        "label",
        "title",
        "titleStatus",
        "titleConfidence",
        "titleUserMessageCount",
        "harness",
        "providerId",
        "model",
        "selectedModelId",
        "selectedReasoningEffort",
        "selectedSpeedTier",
        "selectedPersonality",
        "createdAt",
        "updatedAt",
        "providerResumeId",
        "providerParentResumeId",
        "threadTotalTokens",
        "messageCount",
        "hasUserMessage",
        "lifecycle",
        "status",
        "permissionMode",
    ] {
        if let Some(v) = value.get(field) {
            metadata.insert(field.into(), v.clone());
        }
    }

    let association = session.association.as_ref().unwrap_or(&Value::Null);
    if let Some(level) = association.get("entityLevel") {
        metadata.insert("entityLevel".into(), level.clone());
    }

    if session.review_thread_id.is_some() {
        metadata.insert("kind".into(), json!("discussion"));
    }
    json!({
        "status": session.activity_status,
        "metadata": metadata,
        "task_id": association.get("ticketId"),
        "parent_chat_id": session.parent_chat_id,
        "review_thread_id": session.review_thread_id,
        "gate_execution_id": session.gate.as_ref().map(|g| &g.execution_id),
        "gate_task_run_id": session.gate.as_ref().map(|g| &g.task_run_id),
        "classifications": [],
        "deleted": false
    })
}

/// A persisted report cannot restore a process that no longer exists.
pub(super) fn reset_inactive_activity(
    sessions: &mut [LocalChatSessionIndexEntry],
    live: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut changed = Vec::new();

    for session in sessions {
        if session.activity_status == LocalChatActivityStatus::Working
            && !live.contains(&session.id)
        {
            session.activity_status = LocalChatActivityStatus::Idle;
            changed.push(session.id.clone());
        }
    }

    changed
}

/// Full recovery: read every page, merge it, then deliver pending writes.
/// Reserved for startup, reconnect and explicit recovery.
async fn exchange(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
) -> Result<Recovery, CommandError> {
    let (snapshot, threads) = tokio::try_join!(
        fetch_snapshot(client, project, machine, EntityKind::Chat),
        fetch_snapshot(client, project, machine, EntityKind::Thread),
    )?;
    for entry in threads.into_values() {
        merge(catalog, project, entry);
    }
    for entry in snapshot.values() {
        merge(catalog, project, entry.clone());
    }
    delivery::retry_rejections(catalog, project);
    save(path, catalog)?;
    let delivered = deliver(client, project, machine, catalog, path).await?;
    Ok(Recovery {
        snapshot,
        delivered,
    })
}

struct Recovery {
    snapshot: BTreeMap<EntityKey, Entry>,
    delivered: usize,
}

fn root() -> Result<std::path::PathBuf, CommandError> {
    let root = vertebrae_installer::data_dir().map_err(|_| error())?;
    fs::create_dir_all(&root).map_err(|_| error())?;
    Ok(root)
}

fn state_path(root: &Path, scope: &str) -> std::path::PathBuf {
    root.join(format!("chat-catalog-{scope}.json"))
}

async fn scope_identity(
    root: &Path,
    client: &GraphqlClient,
    machine: &str,
    online: bool,
) -> Result<String, CommandError> {
    let path = root.join("chat-catalog-accounts.json");
    let mut aliases: BTreeMap<String, String> = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(_) => return Err(error()),
    };

    // Known authenticated credentials resolve offline without a network round
    // trip. This also lets pending edits reach disk before reconnect attempts.
    if let Some(scope) = aliases.get(client.connection_identity()) {
        return Ok(scope.clone());
    }

    if online {
        let response = client
            .execute::<Value>(
                "mutation($id:Uuid4!){registerChatInstallation(installationId:$id){id userId}}",
                json!({"id": machine}),
                "registerChatInstallation",
            )
            .await;
        if let Ok(response) = response {
            let user = response["userId"].as_str().ok_or_else(error)?;
            let scope = format!(
                "{:x}",
                Sha256::digest(format!("{}/{user}", client.backend_identity()).as_bytes())
            );
            aliases.insert(client.connection_identity().into(), scope.clone());
            durable_write(&path, &serde_json::to_vec(&aliases).map_err(|_| error())?)?;
            return Ok(scope);
        }
    }

    // Unknown credentials never inherit another account's local catalog.
    aliases
        .get(client.connection_identity())
        .cloned()
        .ok_or_else(error)
}

/// One serialized read or write of the account-scoped catalog.
struct CatalogAccess {
    _serial: tokio::sync::MutexGuard<'static, ()>,
    _disk: fs::File,
    root: std::path::PathBuf,
    client: std::sync::Arc<GraphqlClient>,
    machine: String,
}

impl CatalogAccess {
    async fn open(state: &AppState) -> Result<Option<Self>, CommandError> {
        let _serial = SERIAL.lock().await;
        let Some(client) = state.sacrum_client.read().await.clone() else {
            return Ok(None);
        };
        let root = root()?;
        let _disk = lock_file(&root, ".chat-catalog.lock")?;
        let machine = installation(&root)?;
        Ok(Some(Self {
            _serial,
            _disk,
            root,
            client,
            machine,
        }))
    }

    async fn path(&self, online: bool) -> Result<std::path::PathBuf, CommandError> {
        let scope = scope_identity(&self.root, &self.client, &self.machine, online).await?;
        Ok(state_path(&self.root, &scope))
    }
}

/// Persist pending changes before attempting network IO. A failed exchange is
/// recoverable on the next save/load and never discards the local snapshot.
pub(super) async fn synchronize(
    state: &AppState,
    app: &tauri::AppHandle,
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
    editing: bool,
    deleted_ids: &[String],
    changed_ids: Option<&[String]>,
) -> Result<(), CommandError> {
    let Some(access) = CatalogAccess::open(state).await? else {
        return Ok(());
    };
    let CatalogAccess {
        client,
        machine,
        root,
        ..
    } = &access;
    let identity = scope_identity(root, client, machine, true).await?;
    let path = state_path(root, &identity);
    let mut catalog = load(&path)?;

    // Claim legacy sessions only within the authenticated owner scope.
    let ownership_path = root.join("chat-catalog-ownership.json");
    let mut ownership: BTreeMap<String, String> = match fs::read(&ownership_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(_) => return Err(error()),
    };

    sessions.retain(|s| ownership.get(&s.id).is_none_or(|owner| owner == &identity));
    for session in sessions.iter() {
        ownership
            .entry(session.id.clone())
            .or_insert_with(|| identity.clone());
    }

    durable_write(
        &ownership_path,
        &serde_json::to_vec(&ownership).map_err(|_| error())?,
    )?;

    let projects = state.project_config.get_projects();
    catalog.unmapped = sessions
        .iter()
        .filter(|s| {
            !projects
                .iter()
                .any(|p| s.project_path.as_deref() == Some(p.path.as_str()))
        })
        .map(|s| s.id.clone())
        .collect();

    for project in &projects {
        let before = review_threads::thread_views(&catalog, &project.project_id);
        let local: Vec<_> = sessions
            .iter()
            .filter(|s| s.project_path.as_deref() == Some(project.path.as_str()))
            .collect();

        // Queue explicit edits and previously unseen legacy sessions.
        for session in &local {
            let id = key(&project.project_id, &session.id);
            let chat = EntityKey::chat(&session.id);
            catalog.annotations.insert(
                id.clone(),
                migration::inventory_annotations(root, &session.id)
                    .unwrap_or_else(|_| migration::AnnotationInventory::unavailable()),
            );
            if (editing && changed_ids.is_none_or(|ids| ids.contains(&session.id)))
                || !catalog.sidecars.contains_key(&id)
            {
                catalog
                    .sidecars
                    .insert(id.clone(), migration::Sidecar::from_session(session));
            }

            let mut import_payload = projection(session);
            if let Some(record) = catalog.record(&project.project_id, &chat) {
                import_payload["classifications"] =
                    record.desired.as_ref().unwrap_or(&record.remote.payload)["classifications"]
                        .clone();
            }

            if delivery::parent_deleted(&catalog, &project.project_id, &chat, &import_payload) {
                catalog.migration.pending.remove(&id);
                continue;
            }
            migration::queue(&mut catalog, &id, import_payload.clone());

            if (editing && changed_ids.is_none_or(|ids| ids.contains(&session.id)))
                || catalog.record(&project.project_id, &chat).is_none()
            {
                let absent = catalog.record(&project.project_id, &chat).is_none();
                enqueue(
                    &mut catalog,
                    &project.project_id,
                    &session.id,
                    import_payload,
                );

                if let (true, Some(record)) =
                    (absent, catalog.record_mut(&project.project_id, &chat))
                {
                    record.import_only =
                        !editing || changed_ids.is_some_and(|ids| !ids.contains(&session.id));
                }
            }
        }

        // Only explicit deletions create tombstones.
        if editing {
            for id in deleted_ids {
                let Some(record) = catalog.chat(&project.project_id, id) else {
                    continue;
                };
                let mut payload = record.visible().clone();
                payload["deleted"] = json!(true);
                payload["status"] = json!("idle");
                enqueue(&mut catalog, &project.project_id, id, payload);
            }
        }

        save(&path, &catalog)?;

        let recovered = sync_project(
            client,
            &project.project_id,
            machine,
            &mut catalog,
            &path,
            root,
            editing,
        )
        .await;

        if state
            .sacrum_client
            .read()
            .await
            .as_ref()
            .map(|current| current.connection_identity())
            != Some(client.connection_identity())
        {
            return Err(error());
        }

        catalog = load(&path)?;
        review_threads::publish_thread_changes(app, &project.project_id, before, &catalog);

        if recovered {
            review_threads::publish_thread_recovered(app, &project.project_id);
        }

        // Rebuild visible summaries while retaining local-only sidecars.
        if !editing {
            hydrate_snapshot(&catalog, &project.project_id, &project.path, sessions);
        }
    }
    Ok(())
}

/// Network step of one project. Saves (`editing`) deliver only the outbox, so
/// write acknowledgements and unaffected projects never cause a catalog scan.
/// Full reads are reserved for recovery (load) and migration verification.
async fn sync_project(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
    root: &Path,
    editing: bool,
) -> bool {
    let outcome = if editing {
        deliver(client, project, machine, catalog, path)
            .await
            .map(|_| None)
    } else {
        exchange(client, project, machine, catalog, path)
            .await
            .map(Some)
    };

    let recovery = match outcome {
        Ok(recovery) => recovery,
        Err(_) => {
            tracing::info!(
                pending = catalog
                    .records(project)
                    .filter(|(_, record)| record.desired.is_some())
                    .count(),
                unmapped = catalog.unmapped.len(),
                "chat_catalog_offline"
            );
            None
        }
    };

    let verified = if editing {
        migration::cleanup_index(root, catalog)
    } else {
        // A recovery snapshot taken before any write of this project is
        // already an independent, complete read and can verify imports.
        let snapshot = recovery
            .as_ref()
            .filter(|r| r.delivered == 0)
            .map(|r| &r.snapshot);
        migration::finish(client, project, machine, catalog, path, root, snapshot).await
    };
    if verified.is_err() {
        tracing::info!("chat_catalog_migration_pending");
    }
    recovery.is_some()
}

fn hydrate_snapshot(
    catalog: &Catalog,
    project_id: &str,
    project_path: &str,
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
) {
    // Discussion links support outbox transport. The regular chat index
    // still hydrates only ordinary chats.
    sessions.retain(|session| {
        session.project_path.as_deref() != Some(project_path) || session.review_thread_id.is_none()
    });

    for (id, record) in catalog.records(project_id) {
        let EntityKey::Chat(chat) = id else {
            continue;
        };
        if delivery::is_discussion(record.visible()) {
            sessions.retain(|s| s.id != chat.0);
            continue;
        }

        let previous = sessions.iter().find(|s| s.id == chat.0).cloned();
        let scoped_id = key(project_id, &chat.0);
        match hydrate_record(
            catalog,
            &scoped_id,
            &chat.0,
            record,
            project_path,
            previous.as_ref(),
        ) {
            Hydrated::Deleted => sessions.retain(|s| s.id != chat.0),
            Hydrated::Session(session) => {
                sessions.retain(|s| s.id != chat.0);
                sessions.push(*session);
            }
            Hydrated::Invalid => {}
        }
    }
}

enum Hydrated {
    Deleted,
    Session(Box<LocalChatSessionIndexEntry>),
    Invalid,
}

/// Visible summary of one catalog record. Local-only association and gate
/// details come from the previous visible session or the durable sidecar.
fn hydrate_record(
    catalog: &Catalog,
    id: &str,
    chat_id: &str,
    record: &Record,
    project_path: &str,
    previous: Option<&LocalChatSessionIndexEntry>,
) -> Hydrated {
    let payload = record.desired.as_ref().unwrap_or(&record.remote.payload);
    if payload["deleted"] == true {
        return Hydrated::Deleted;
    }

    let mut value = payload["metadata"].clone();
    value["activityStatus"] = payload
        .get("status")
        .cloned()
        .unwrap_or_else(|| json!("idle"));
    value["id"] = json!(chat_id);
    value["projectPath"] = json!(project_path);
    let sidecar = catalog.sidecars.get(id);
    value["gate"] = previous
        .and_then(|s| s.gate.as_ref())
        .or_else(|| sidecar.and_then(|s| s.gate.as_ref()))
        .map(|g| serde_json::to_value(g).unwrap())
        .unwrap_or(Value::Null);

    let mut association = previous
        .and_then(|s| s.association.clone())
        .or_else(|| sidecar.and_then(|s| s.association.clone()))
        .unwrap_or_else(|| {
            json!({
                "ticketId": null,
                "ticketTitle": null,
                "worktreePath": null,
                "branch": null,
                "lastProcessedAt": null,
                "processedAtCount": 0,
                "awaitingWorktree": null,
                "recentWorktrees": []
            })
        });
    association["ticketId"] = payload["task_id"].clone();
    // The association reader requires an explicit nullable title. Titles are
    // not stored in local sidecars and must not survive an entity rebind.
    association["ticketTitle"] = Value::Null;
    association["entityLevel"] = payload["metadata"]
        .get("entityLevel")
        .cloned()
        .filter(|v| v.is_string())
        .unwrap_or_else(|| json!("ticket"));
    value["association"] = association;

    match serde_json::from_value(value) {
        Ok(session) => Hydrated::Session(Box::new(session)),
        Err(_) => Hydrated::Invalid,
    }
}

/// Typed `chat_catalog_*` CDC entry broadcast on a project channel.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct CatalogChange {
    pub project_id: String,
    pub installation_id: String,
    pub chat_id: String,
    pub revision: u64,
    pub payload: Value,
}

/// Visible result of a merged CDC entry; `session` is `None` for a tombstone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEntryChanged {
    pub session_id: String,
    pub session: Option<LocalChatSessionIndexEntry>,
}

/// Durably merge a CDC entry into the account-scoped cache. Returns the
/// visible update to publish, or `None` when the entry is unrelated, already
/// applied (including own-write echoes) or leaves the visible projection
/// unchanged. Never reads the remote catalog.
pub(crate) async fn apply_change<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    change: CatalogChange,
) -> Result<Option<CatalogEntryChanged>, CommandError> {
    let Some(access) = CatalogAccess::open(state).await? else {
        return Ok(None);
    };
    let Some(project) = change_scope(
        &change,
        &access.machine,
        state.project_config.get_projects(),
    ) else {
        return Ok(None);
    };
    // Unknown credentials cannot resolve another account's catalog.
    let Ok(path) = access.path(false).await else {
        return Ok(None);
    };
    let mut catalog = load(&path)?;
    let before = review_threads::thread_views(&catalog, &project.project_id);
    let update = apply_chat_entry(
        &mut catalog,
        &path,
        &project.project_id,
        &project.path,
        change,
    )?;
    review_threads::publish_thread_changes(app, &project.project_id, before, &catalog);
    Ok(update)
}

/// The configured project an entry belongs to, if it targets this installation.
fn change_scope(
    change: &CatalogChange,
    machine: &str,
    projects: Vec<crate::project_config::SavedProject>,
) -> Option<crate::project_config::SavedProject> {
    if change.installation_id != machine {
        return None;
    }
    configured_project(projects, &change.project_id)
}

fn configured_project(
    projects: Vec<crate::project_config::SavedProject>,
    project_id: &str,
) -> Option<crate::project_config::SavedProject> {
    projects.into_iter().find(|p| p.project_id == project_id)
}

fn apply_chat_entry(
    catalog: &mut Catalog,
    path: &Path,
    project_id: &str,
    project_path: &str,
    change: CatalogChange,
) -> Result<Option<CatalogEntryChanged>, CommandError> {
    let id = key(project_id, &change.chat_id);
    let hidden = delivery::is_discussion(&change.payload)
        || catalog
            .chat(project_id, &change.chat_id)
            .is_some_and(|record| delivery::is_discussion(record.visible()));
    if !apply_entry(
        catalog,
        path,
        project_id,
        Entry {
            id: EntityKey::chat(&change.chat_id),
            revision: change.revision,
            payload: change.payload,
        },
    )? || hidden
    {
        return Ok(None);
    }
    let record = catalog
        .chat(project_id, &change.chat_id)
        .expect("merged chat");
    let session = match hydrate_record(catalog, &id, &change.chat_id, record, project_path, None) {
        Hydrated::Deleted => None,
        Hydrated::Session(session) => Some(*session),
        Hydrated::Invalid => return Ok(None),
    };
    Ok(Some(CatalogEntryChanged {
        session_id: change.chat_id,
        session,
    }))
}

/// Merge a CDC row and report whether the visible payload changed.
fn apply_entry(
    catalog: &mut Catalog,
    path: &Path,
    project: &str,
    entry: Entry,
) -> Result<bool, CommandError> {
    let id = entry.id.clone();
    let previous = catalog
        .record(project, &id)
        .map(|record| record.visible().clone());
    if !merge_entry(catalog, project, entry, MergeSource::Observed) {
        return Ok(false);
    }
    save(path, catalog)?;

    let record = catalog.record(project, &id).expect("merged record");
    if previous.as_ref() == Some(record.visible()) {
        return Ok(false);
    }
    tracing::info!(
        entity_id = %id,
        kind = id.kind().field(),
        revision = record.remote.revision,
        "chat_catalog_cdc_applied"
    );
    Ok(true)
}

/// Return true when backend persistence handled the write. Do not recreate
/// already retired legacy rows on subsequent saves, including offline edits.
pub(super) async fn save_pending_legacy(
    state: &AppState,
    path: &Path,
    mut sessions: Vec<LocalChatSessionIndexEntry>,
) -> Result<bool, CommandError> {
    let Some(access) = CatalogAccess::open(state).await? else {
        return Ok(false);
    };
    let catalog = load(&access.path(false).await?)?;
    sessions.retain(|session| !migration::can_retire(&catalog, session));

    if sessions.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => fs::File::open(&access.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| error())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error()),
        }
    } else {
        durable_write(
            path,
            &serde_json::to_vec(&json!({"version": 1, "sessions": sessions}))
                .map_err(|_| error())?,
        )?;
    }
    Ok(true)
}

/// Preserve other-account local-only sidecars when replacing the selected
/// account's visible snapshot. Annotation sweeping must see the global union.
pub(super) async fn preserve_sidecars(
    state: &AppState,
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
    previous: Vec<LocalChatSessionIndexEntry>,
    deleted: &[String],
) -> Result<(), CommandError> {
    let Some(access) = CatalogAccess::open(state).await? else {
        return Ok(());
    };
    let scope = scope_identity(&access.root, &access.client, &access.machine, false).await?;
    let ownership: BTreeMap<String, String> = serde_json::from_slice(
        &fs::read(access.root.join("chat-catalog-ownership.json")).map_err(|_| error())?,
    )
    .map_err(|_| error())?;
    merge_sidecars(sessions, previous, deleted, &ownership, &scope);
    Ok(())
}

fn merge_sidecars(
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
    previous: Vec<LocalChatSessionIndexEntry>,
    deleted: &[String],
    ownership: &BTreeMap<String, String>,
    scope: &str,
) {
    for old in previous {
        if sessions.iter().any(|s| s.id == old.id) {
            continue;
        }
        if ownership.get(&old.id).is_some_and(|owner| owner == scope) && deleted.contains(&old.id) {
            continue;
        }

        sessions.push(old);
    }
}

fn project_id_for_path(state: &AppState, project_path: &str) -> Result<String, CommandError> {
    state
        .project_config
        .get_projects()
        .into_iter()
        .find(|p| p.path == project_path)
        .map(|p| p.project_id)
        .ok_or_else(error)
}

pub(super) async fn load_classifications(
    state: &AppState,
    project_path: &str,
    chat_id: &str,
) -> Result<Vec<super::tool_activity::Classification>, CommandError> {
    let project = project_id_for_path(state, project_path)?;
    let access = CatalogAccess::open(state).await?.ok_or_else(error)?;
    let catalog = load(&access.path(false).await?)?;
    let record = catalog.chat(&project, chat_id).ok_or_else(error)?;
    let payload = record.desired.as_ref().unwrap_or(&record.remote.payload);
    if payload["deleted"] == true {
        return Err(error());
    }

    serde_json::from_value(payload["classifications"].clone()).map_err(|_| error())
}

pub(super) async fn store_classifications(
    state: &AppState,
    app: &tauri::AppHandle,
    project_path: &str,
    chat_id: &str,
    classifications: Vec<super::tool_activity::Classification>,
    expected_connection: &str,
) -> Result<(), CommandError> {
    let project = project_id_for_path(state, project_path)?;
    let access = CatalogAccess::open(state).await?.ok_or_else(error)?;
    if access.client.connection_identity() != expected_connection {
        return Err(error());
    }

    let path = access.path(false).await?;
    let mut catalog = load(&path)?;
    let record = catalog.chat(&project, chat_id).ok_or_else(error)?;
    let mut payload = record
        .desired
        .as_ref()
        .unwrap_or(&record.remote.payload)
        .clone();
    if payload["deleted"] == true {
        return Err(error());
    }

    let mut all: Vec<super::tool_activity::Classification> =
        serde_json::from_value(payload["classifications"].clone()).map_err(|_| error())?;
    for entry in classifications {
        all.retain(|old| old.tool_id != entry.tool_id);
        all.push(entry);
    }
    if all.len() > 1024 {
        tracing::warn!(
            chat_id = chat_id,
            limit = 1024,
            "chat_classification_capacity"
        );
        return Err(error());
    }

    let before = review_threads::thread_views(&catalog, &project);
    payload["classifications"] = serde_json::to_value(all).map_err(|_| error())?;
    enqueue(&mut catalog, &project, chat_id, payload);
    save(&path, &catalog)?;
    let _ = deliver(
        &access.client,
        &project,
        &access.machine,
        &mut catalog,
        &path,
    )
    .await;
    let durable = load(&path)?;
    review_threads::publish_thread_changes(app, &project, before, &durable);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::entity::Remote;
    use super::*;
    use delivery::DELIVERY_ATTEMPTS;
    use hegel::{generators as gs, TestCase};
    use vertebrae_sacrum_client::SacrumConfig;
    use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

    pub(super) fn empty_thread_snapshot() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({
            "data": {"reviewThreads": {"entries": [], "nextCursor": null}}
        }))
    }

    pub(super) fn payload(n: u8) -> Value {
        json!({
            "status": "idle",
            "metadata": {
                "label": format!("chat-{n}"),
                "harness": "claude",
                "titleUserMessageCount": 0,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "messageCount": 1,
                "lifecycle": "idle",
                "status": "open"
            },
            "task_id": null,
            "parent_chat_id": null,
            "gate_execution_id": null,
            "gate_task_run_id": null,
            "classifications": [],
            "deleted": false
        })
    }

    #[tokio::test]
    async fn token_rotation_preserves_owner_scope_but_another_account_never_inherits_it() {
        let server = MockServer::start().await;

        Mock::given(matchers::method("POST"))
            .respond_with(|request: &wiremock::Request| {
                let token = request
                    .headers
                    .get("authorization")
                    .unwrap()
                    .to_str()
                    .unwrap();
                let user = if token == "Bearer account-b" {
                    "owner-b"
                } else {
                    "owner-a"
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": {
                        "registerChatInstallation": {"id": "machine", "userId": user}
                    }
                }))
            })
            .mount(&server)
            .await;

        let client = |token: &str| {
            GraphqlClient::new(SacrumConfig {
                base_url: server.uri(),
                api_token: token.into(),
                project_id: "p".into(),
            })
        };
        let dir = tempfile::tempdir().unwrap();

        let original = scope_identity(dir.path(), &client("account-a-old"), "machine", true)
            .await
            .unwrap();

        assert_eq!(
            scope_identity(dir.path(), &client("account-a-new"), "machine", true)
                .await
                .unwrap(),
            original
        );

        assert_eq!(
            scope_identity(dir.path(), &client("account-a-new"), "machine", false)
                .await
                .unwrap(),
            original
        );

        let other = scope_identity(dir.path(), &client("account-b"), "machine", true)
            .await
            .unwrap();
        assert_ne!(other, original);
        let thread = Uuid::new_v4();
        let mut catalog = Catalog::default();
        let thread = EntityKey::Thread(ThreadId(thread));
        enqueue_entity(&mut catalog, "project", &thread, json!({"deleted": false}));
        save(&state_path(dir.path(), &original), &catalog).unwrap();
        assert!(load(&state_path(dir.path(), &other))
            .unwrap()
            .records("project")
            .next()
            .is_none());
        let rotated = scope_identity(dir.path(), &client("account-a-new"), "machine", false)
            .await
            .unwrap();
        assert!(load(&state_path(dir.path(), &rotated))
            .unwrap()
            .record("project", &thread)
            .is_some());

        assert!(
            scope_identity(dir.path(), &client("unknown-offline"), "machine", false)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "requires an explicitly provisioned disposable Sacrum fixture"]
    async fn real_backend_catalog_roundtrip_restart_and_tombstone() {
        let env =
            |key: &str| std::env::var(key).expect("disposable chat test environment required");
        let project = env("VTB_CHAT_TEST_PROJECT_ID");

        let client = GraphqlClient::new(SacrumConfig {
            base_url: env("VTB_CHAT_TEST_URL"),
            api_token: env("VTB_CHAT_TEST_TOKEN"),
            project_id: project.clone(),
        });
        let dir = tempfile::tempdir().unwrap();
        let machine = installation(dir.path()).unwrap();
        scope_identity(dir.path(), &client, &machine, true)
            .await
            .unwrap();
        let chat = uuid::Uuid::new_v4().to_string();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        let mut data = payload(17);
        data["review_thread_id"] = Value::Null;
        data["classifications"] = json!([
            {
                "tool_id": "c".repeat(64),
                "input_hash": "a".repeat(64),
                "classifier_fingerprint": "b".repeat(64),
                "labels": []
            }
        ]);
        let rejected_chat = format!("0-{chat}");

        let mut invalid = data.clone();
        invalid["status"] = json!("unsupported");
        enqueue(&mut catalog, &project, &rejected_chat, invalid.clone());
        enqueue(&mut catalog, &project, &chat, data.clone());
        save(&path, &catalog).unwrap();

        exchange(&client, &project, &machine, &mut catalog, &path)
            .await
            .unwrap();

        assert!(catalog.chat(&project, &chat).unwrap().desired.is_none());
        assert_eq!(catalog.chat(&project, &chat).unwrap().remote.payload, data);

        let mut restarted = load(&path).unwrap();
        assert_eq!(
            restarted
                .chat(&project, &rejected_chat)
                .unwrap()
                .desired
                .as_ref(),
            Some(&invalid)
        );
        assert_eq!(
            restarted
                .chat(&project, &rejected_chat)
                .unwrap()
                .rejection_code
                .as_deref(),
            Some("invalid_payload")
        );

        exchange(&client, &project, &machine, &mut restarted, &path)
            .await
            .unwrap();
        assert_eq!(
            restarted.chat(&project, &chat).unwrap().remote.payload,
            data
        );
        assert_eq!(restarted.chat(&project, &chat).unwrap().remote.revision, 1);

        data["deleted"] = json!(true);
        enqueue(&mut restarted, &project, &chat, data);
        save(&path, &restarted).unwrap();

        exchange(&client, &project, &machine, &mut restarted, &path)
            .await
            .unwrap();
        enqueue(&mut restarted, &project, &chat, payload(22));
        assert!(restarted.chat(&project, &chat).unwrap().desired.is_none());
        assert_eq!(
            restarted.chat(&project, &chat).unwrap().remote.payload["deleted"],
            true
        );
        println!(
            "real_backend_catalog_roundtrip_restart_and_tombstone: accepted/reloaded/empty-labels/terminal-delete passed"
        );
    }

    #[test]
    fn replacing_visible_owner_snapshot_preserves_foreign_git_sidecars() {
        let entry = |id: &str| {
            let mut value = payload(1)["metadata"].clone();
            value["id"] = json!(id);
            value["association"] = json!({"worktreePath": "local-only"});
            serde_json::from_value::<LocalChatSessionIndexEntry>(value).unwrap()
        };
        let foreign = entry("foreign");
        let own = entry("own");
        let mut visible = vec![];
        let ownership = BTreeMap::from([
            ("foreign".into(), "other".into()),
            ("own".into(), "current".into()),
        ]);

        merge_sidecars(
            &mut visible,
            vec![foreign, own],
            &["foreign".into(), "own".into()],
            &ownership,
            "current",
        );

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "foreign");
        assert_eq!(
            visible[0].association.as_ref().unwrap()["worktreePath"],
            "local-only"
        );
    }

    #[test]
    fn repeated_legacy_import_prefers_already_acknowledged_server_record() {
        let mut catalog = Catalog::default();
        enqueue(&mut catalog, "project", "chat", payload(1));
        catalog
            .record_mut("project", &EntityKey::chat("chat"))
            .unwrap()
            .import_only = true;

        let mut canonical = payload(9);
        canonical["classifications"] = json!([{"labels": []}]);
        merge(
            &mut catalog,
            "project",
            Entry {
                id: EntityKey::chat("chat"),
                revision: 7,
                payload: canonical.clone(),
            },
        );

        assert!(catalog.chat("project", "chat").unwrap().desired.is_none());
        assert_eq!(
            catalog.chat("project", "chat").unwrap().remote.payload,
            canonical
        );
    }

    #[tokio::test]
    async fn first_chat_write_uses_the_new_client_installation_id_without_a_managed_backend() {
        let root = tempfile::tempdir().unwrap();
        assert!(!root.path().join("chat-installation-id").exists());
        let installation_id = installation(root.path()).unwrap();
        assert!(!uuid::Uuid::parse_str(&installation_id).unwrap().is_nil());

        let server = MockServer::start().await;
        let expected_id = installation_id.clone();
        Mock::given(matchers::method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let query = body["query"].as_str().unwrap();
                if query.contains("reviewThreads(") {
                    return empty_thread_snapshot();
                }

                let variables = &body["variables"];

                if query.contains("registerChatInstallation") {
                    assert_eq!(variables["id"], expected_id);
                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": {"registerChatInstallation": {
                            "id": expected_id, "userId": "owner"
                        }}
                    }));
                }

                // Both the catalog read and chat write use the same generated
                // client identity, without provisioning any local backend stack.
                assert_eq!(variables["m"], expected_id);
                if query.contains("putChatCatalog") {
                    let payload: Value =
                        serde_json::from_str(variables["v"].as_str().unwrap()).unwrap();
                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": {"putChatCatalog": {
                            "status": "accepted",
                            "entry": {"chatId": "chat", "revision": 1, "payload": payload}
                        }}
                    }));
                }
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": {"chatCatalog": {"entries": [], "nextCursor": null}}
                }))
            })
            .expect(4)
            .mount(&server)
            .await;
        let client = GraphqlClient::new(SacrumConfig {
            base_url: server.uri(),
            api_token: "fixture".into(),
            project_id: "project".into(),
        });
        scope_identity(root.path(), &client, &installation_id, true)
            .await
            .unwrap();
        let path = root.path().join("catalog.json");
        let mut catalog = Catalog::default();
        enqueue(&mut catalog, "project", "chat", payload(1));

        exchange(&client, "project", &installation_id, &mut catalog, &path)
            .await
            .unwrap();

        assert!(catalog.chat("project", "chat").unwrap().desired.is_none());
        assert_eq!(installation(root.path()).unwrap(), installation_id);
        server.verify().await;
    }

    #[test]
    fn installation_is_stable_and_corrupt_identity_never_silently_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let id = installation(dir.path()).unwrap();
        assert_eq!(installation(dir.path()).unwrap(), id);

        fs::write(dir.path().join("chat-installation-id"), "broken").unwrap();
        assert!(installation(dir.path()).is_err());
    }

    #[test]
    fn activity_roundtrips_and_restart_clears_only_reports_without_live_runtimes() {
        let entry = |id: &str| {
            let mut value = payload(1)["metadata"].clone();
            value["id"] = json!(id);
            value["activityStatus"] = json!("working");
            serde_json::from_value::<LocalChatSessionIndexEntry>(value).unwrap()
        };
        let mut sessions = vec![entry("live"), entry("stale")];
        assert_eq!(projection(&sessions[0])["status"], "working");
        let live = std::collections::HashSet::from(["live".to_string()]);
        assert_eq!(reset_inactive_activity(&mut sessions, &live), vec!["stale"]);
        assert_eq!(projection(&sessions[0])["status"], "working");
        assert_eq!(projection(&sessions[1])["status"], "idle");
        assert!(reset_inactive_activity(&mut sessions, &live).is_empty());

        let reloaded: Vec<LocalChatSessionIndexEntry> =
            serde_json::from_slice(&serde_json::to_vec(&sessions).unwrap()).unwrap();
        assert_eq!(
            reloaded[0].activity_status,
            LocalChatActivityStatus::Working
        );
        assert_eq!(reloaded[1].activity_status, LocalChatActivityStatus::Idle);
    }

    #[hegel::test]
    fn projection_drops_arbitrary_git_fields_and_bookkeeping(tc: TestCase) {
        let marker = format!("private-{}", tc.draw(gs::integers::<u64>()));
        let task_id = "00000000-0000-4000-8000-000000000001";
        let mut raw = payload(1)["metadata"].clone();
        raw["id"] = json!("identity");
        raw["projectPath"] = json!(marker);
        raw["messages"] = json!([marker]);
        raw["association"] = json!({
            "ticketId": task_id,
            "worktreePath": marker,
            "worktreeBranch": marker,
            "lastEventId": marker,
            "recentWorktrees": [
                marker
            ],
            "pendingCreation": marker
        });
        for field in ["patch", "files", "worktree", "input", "result"] {
            raw[field] = json!(marker);
        }

        let session: LocalChatSessionIndexEntry = serde_json::from_value(raw).unwrap();
        let wire = projection(&session);

        assert!(!wire.to_string().contains(&marker));
        assert_eq!(wire["task_id"], task_id);
        assert!(wire.get("entity_id").is_none());
        assert_eq!(wire["metadata"]["label"], "chat-1");
        assert_eq!(wire["classifications"], json!([]));
        assert!(wire.get("projectPath").is_none());
    }

    // The oracle stores only final user intent and a monotonic terminal-delete
    // bit. It has no revision/outbox implementation in common with the SUT.
    #[hegel::test]
    fn model_interleavings_preserve_latest_intent_and_terminal_deletion(tc: TestCase) {
        let mut state = Catalog::default();
        let mut expected: BTreeMap<(u8, u8), Option<u8>> = BTreeMap::new();
        let mut revision = 0;
        let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(80));

        for _ in 0..count {
            let project = tc.draw(gs::integers::<u8>().max_value(2));
            let chat = tc.draw(gs::integers::<u8>().max_value(3));
            let operation = tc.draw(gs::integers::<u8>().max_value(6));
            let value = tc.draw(gs::integers::<u8>());
            let p = project.to_string();
            let c = chat.to_string();
            let id = EntityKey::chat(&c);

            match operation {
                0..=2 => {
                    if expected.get(&(project, chat)) != Some(&None) {
                        expected.insert((project, chat), Some(value));
                    }
                    enqueue(&mut state, &p, &c, payload(value));
                }
                3 => {
                    // deletion, including offline/imported records
                    if let Some(expected) = expected.get_mut(&(project, chat)) {
                        *expected = None;
                        let record = state.record(&p, &id).unwrap();
                        let mut deleted = record
                            .desired
                            .as_ref()
                            .unwrap_or(&record.remote.payload)
                            .clone();
                        deleted["deleted"] = json!(true);
                        enqueue(&mut state, &p, &c, deleted);
                    }
                }
                4 => {
                    // serialize/restart at any boundary
                    state = storage::decode(&storage::encode(&state).unwrap()).unwrap();
                }
                5 => {
                    // delivery and ack, then duplicated/reordered older event
                    if let Some(record) = state.record_mut(&p, &id) {
                        if let Some(desired) = record.desired.take() {
                            revision += 1;
                            record.remote = Remote {
                                revision,
                                payload: desired,
                            };
                        }
                        let current = Entry {
                            id: id.clone(),
                            revision: record.remote.revision,
                            payload: record.remote.payload.clone(),
                        };
                        merge(&mut state, &p, current);
                        if revision > 0 {
                            merge(
                                &mut state,
                                &p,
                                Entry {
                                    id: EntityKey::chat(c),
                                    revision: 0,
                                    payload: payload(0),
                                },
                            );
                        }
                    }
                }
                _ => {
                    // remote delete racing a pending inference or manual correction
                    if state.record(&p, &id).is_some() {
                        revision += 1;
                        expected.insert((project, chat), None);
                        let mut deleted = payload(0);
                        deleted["deleted"] = json!(true);
                        merge(
                            &mut state,
                            &p,
                            Entry {
                                id: EntityKey::chat(c),
                                revision,
                                payload: deleted,
                            },
                        );
                    }
                }
            }

            for ((project, chat), intent) in &expected {
                let record = &state.chat(&project.to_string(), &chat.to_string()).unwrap();
                let actual = record.desired.as_ref().unwrap_or(&record.remote.payload);
                match intent {
                    None => assert_eq!(actual["deleted"], true),
                    Some(n) => {
                        assert_eq!(actual["deleted"], false);
                        assert_eq!(actual["metadata"]["label"], format!("chat-{n}"));
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn catalog_snapshot_follows_every_cursor_without_user_pagination() {
        let server = MockServer::start().await;
        let cursors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let observed = cursors.clone();

        Mock::given(matchers::method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                if body["query"].as_str().unwrap().contains("reviewThreads(") {
                    return empty_thread_snapshot();
                }
                assert!(body["query"]
                    .as_str()
                    .unwrap()
                    .contains("includeCompleted:true"));
                assert_eq!(body["variables"]["p"], "project");
                assert_eq!(body["variables"]["m"], "machine");
                let cursor = body["variables"]["after"].clone();
                observed.lock().unwrap().push(cursor.clone());
                let (id, next) = match cursor.as_str() {
                    None => ("a", Some("a")),
                    Some("a") => ("b", Some("b")),
                    Some("b") => ("c", None),
                    _ => panic!("unexpected cursor"),
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": {
                        "chatCatalog": {
                            "entries": [{"chatId": id, "revision": 1, "payload": payload(1)}],
                            "nextCursor": next
                        }
                    }
                }))
            })
            .expect(4)
            .mount(&server)
            .await;

        let client = GraphqlClient::new(SacrumConfig {
            base_url: server.uri(),
            api_token: "fixture".into(),
            project_id: "project".into(),
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();

        exchange(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();

        assert_eq!(
            *cursors.lock().unwrap(),
            vec![Value::Null, json!("a"), json!("b")]
        );
        assert_eq!(
            catalog
                .records("project")
                .map(|(id, _)| id.to_string())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(load(&path).unwrap().records("project").count(), 3);
        server.verify().await;
    }

    #[tokio::test]
    async fn wire_protocol_retries_lost_ack_idempotently_and_excludes_local_data() {
        let server = MockServer::start().await;

        #[derive(Default)]
        struct RemoteState {
            entry: Option<Entry>,
            last_mutation_id: Option<String>,
            acknowledgement_lost: bool,
        }

        let remote = std::sync::Arc::new(std::sync::Mutex::new(RemoteState::default()));
        let model = remote.clone();

        Mock::given(matchers::method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let query = body["query"].as_str().unwrap();
                if query.contains("reviewThreads(") {
                    return empty_thread_snapshot();
                }

                let vars = &body["variables"];

                if query.contains("registerChatInstallation") {
                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": {
                            "registerChatInstallation": {"id": vars["id"]}
                        }
                    }));
                }

                let mut model = model.lock().unwrap();

                if query.contains("chatCatalog(") {
                    let entries: Vec<_> = model
                        .entry
                        .iter()
                        .map(|entry| {
                            json!({
                                "chatId": entry.id.to_string(),
                                "revision": entry.revision,
                                "payload": entry.payload
                            })
                        })
                        .collect();

                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": {
                            "chatCatalog": {
                                "entries": entries,
                                "nextCursor": null
                            }
                        }
                    }));
                }

                let payload: Value = serde_json::from_str(vars["v"].as_str().unwrap()).unwrap();
                assert!(!payload.to_string().contains("private"));

                let mutation = vars["n"].as_str().unwrap().to_string();
                if model.last_mutation_id.as_ref() != Some(&mutation) {
                    let revision = model.entry.as_ref().map_or(1, |e| e.revision + 1);
                    assert_eq!(vars["r"].as_u64().unwrap(), revision - 1);
                    model.entry = Some(Entry {
                        id: EntityKey::chat(vars["c"].as_str().unwrap()),
                        revision,
                        payload,
                    });
                    model.last_mutation_id = Some(mutation);
                }

                // Simulate a committed write whose first acknowledgement is lost.
                if !model.acknowledgement_lost {
                    model.acknowledgement_lost = true;
                    return ResponseTemplate::new(503);
                }

                let row = model.entry.as_ref().unwrap();
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": {
                        "putChatCatalog": {
                            "status": "accepted",
                            "entry": {
                                "chatId": row.id.to_string(),
                                "revision": row.revision,
                                "payload": row.payload
                            }
                        }
                    }
                }))
            })
            .mount(&server)
            .await;

        let client = GraphqlClient::new(SacrumConfig {
            base_url: server.uri(),
            api_token: "fixture".into(),
            project_id: "project".into(),
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        enqueue(&mut catalog, "project", "chat", payload(7));
        save(&path, &catalog).unwrap();
        let mutation = catalog.chat("project", "chat").unwrap().mutation_id.clone();
        assert!(exchange(&client, "project", "machine", &mut catalog, &path)
            .await
            .is_err());

        let mut restarted = load(&path).unwrap();
        assert_eq!(
            restarted.chat("project", "chat").unwrap().mutation_id,
            mutation
        );

        exchange(&client, "project", "machine", &mut restarted, &path)
            .await
            .unwrap();
        assert!(restarted.chat("project", "chat").unwrap().desired.is_none());
        assert_eq!(
            restarted.chat("project", "chat").unwrap().remote.revision,
            1
        );

        let expected: Value =
            serde_json::from_slice(&fs::read(path.with_extension("expected.json")).unwrap())
                .unwrap();
        assert_eq!(expected["pending"], json!([]));
        assert_eq!(expected["projects"][0]["entries"][0]["payload"], payload(7));
    }

    /// Records the kind of each GraphQL request ("scan" or "put").
    type Requests = std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>;

    async fn counting_server(
        respond: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> (MockServer, GraphqlClient, Requests) {
        let server = MockServer::start().await;
        let requests = Requests::default();
        let observed = requests.clone();
        Mock::given(matchers::method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let query = body["query"].as_str().unwrap();
                if query.contains("reviewThreads(") {
                    return empty_thread_snapshot();
                }

                observed
                    .lock()
                    .unwrap()
                    .push(if query.contains("putChatCatalog") {
                        "put"
                    } else {
                        assert!(query.contains("chatCatalog("));
                        "scan"
                    });
                ResponseTemplate::new(200).set_body_json(json!({"data": respond(&body)}))
            })
            .mount(&server)
            .await;
        let client = GraphqlClient::new(SacrumConfig {
            base_url: server.uri(),
            api_token: "fixture".into(),
            project_id: "project".into(),
        });
        (server, client, requests)
    }

    pub(super) fn accept(body: &Value, revision: u64) -> Value {
        let vars = &body["variables"];
        let payload: Value = serde_json::from_str(vars["v"].as_str().unwrap()).unwrap();
        json!({"putChatCatalog": {
            "status": "accepted",
            "entry": {"chatId": vars["c"], "revision": revision, "payload": payload}
        }})
    }

    fn acknowledged(catalog: &mut Catalog, project: &str, chat: &str, revision: u64, n: u8) {
        merge(
            catalog,
            project,
            Entry {
                id: EntityKey::chat(chat),
                revision,
                payload: payload(n),
            },
        );
    }

    #[tokio::test]
    async fn saves_deliver_only_changed_entries_without_scanning_any_project() {
        let (_server, client, requests) = counting_server(|body| {
            assert_eq!(
                body["variables"]["r"], 3,
                "expected revision comes from cache"
            );
            assert_eq!(body["variables"]["p"], "edited");
            accept(body, 4)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "edited", "chat", 3, 1);
        acknowledged(&mut catalog, "edited", "other", 9, 1);
        acknowledged(&mut catalog, "untouched", "chat", 5, 1);
        // Unverified imports must not turn a save into a verification scan.
        migration::queue(&mut catalog, "edited/chat", payload(1));
        migration::queue(&mut catalog, "untouched/chat", payload(1));

        // An identical projection (usage-only, lifecycle-only) queues nothing.
        enqueue(&mut catalog, "edited", "other", payload(1));
        enqueue(&mut catalog, "untouched", "chat", payload(1));
        enqueue(&mut catalog, "edited", "chat", payload(2));
        for project in ["edited", "untouched"] {
            sync_project(
                &client,
                project,
                "machine",
                &mut catalog,
                &path,
                dir.path(),
                true,
            )
            .await;
        }

        assert_eq!(*requests.lock().unwrap(), ["put"]);
        assert!(catalog.chat("edited", "chat").unwrap().desired.is_none());
        assert_eq!(catalog.chat("edited", "chat").unwrap().remote.revision, 4);

        // Repeating the save with nothing pending issues zero requests.
        sync_project(
            &client,
            "edited",
            "machine",
            &mut catalog,
            &path,
            dir.path(),
            true,
        )
        .await;
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn new_classification_is_a_single_mutation_without_a_scan() {
        let (_server, client, requests) = counting_server(|body| {
            let sent: Value =
                serde_json::from_str(body["variables"]["v"].as_str().unwrap()).unwrap();
            assert_eq!(sent["classifications"][0]["tool_id"], "t");
            accept(body, 2)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "chat", 1, 1);

        let mut classified = payload(1);
        classified["classifications"] = json!([{"tool_id": "t"}]);
        enqueue(&mut catalog, "project", "chat", classified);
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();

        assert_eq!(*requests.lock().unwrap(), ["put"]);
    }

    #[tokio::test]
    async fn conflicts_converge_on_authoritative_revisions_with_bounded_retries() {
        // Remote moved to revision 4; the retry carries the authoritative revision.
        let (_server, client, requests) =
            counting_server(|body| match body["variables"]["r"].as_u64().unwrap() {
                1 => json!({"putChatCatalog": {
                    "status": "conflict",
                    "entry": {"chatId": "chat", "revision": 4, "payload": payload(9)}
                }}),
                4 => accept(body, 5),
                other => panic!("unexpected expected revision {other}"),
            })
            .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "chat", 1, 1);
        enqueue(&mut catalog, "project", "chat", payload(2));
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();
        assert_eq!(*requests.lock().unwrap(), ["put", "put"]);
        let record = &catalog.chat("project", "chat").unwrap();
        assert!(record.desired.is_none() && !record.conflicted);
        assert_eq!(record.remote.revision, 5);
        assert_eq!(record.remote.payload, payload(2));

        // A permanently conflicting backend stops after the bounded attempts and
        // retains the intent durably for a later retry.
        let (_server, client, requests) = counting_server(|body| {
            let revision = body["variables"]["r"].as_u64().unwrap() + 1;
            json!({"putChatCatalog": {
                "status": "conflict",
                "entry": {"chatId": "chat", "revision": revision, "payload": payload(9)}
            }})
        })
        .await;
        enqueue(&mut catalog, "project", "chat", payload(3));
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();
        assert_eq!(requests.lock().unwrap().len(), DELIVERY_ATTEMPTS);
        let restarted = load(&path).unwrap();
        assert!(restarted.chat("project", "chat").unwrap().conflicted);
        assert_eq!(
            restarted.chat("project", "chat").unwrap().desired,
            Some(payload(3))
        );

        // A remote tombstone wins and can never be resurrected.
        let (_server, client, requests) = counting_server(|_| {
            let mut deleted = payload(0);
            deleted["deleted"] = json!(true);
            json!({"putChatCatalog": {
                "status": "conflict",
                "entry": {"chatId": "chat", "revision": 20, "payload": deleted}
            }})
        })
        .await;
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        enqueue(&mut catalog, "project", "chat", payload(4));
        assert!(catalog.chat("project", "chat").unwrap().desired.is_none());
        assert_eq!(
            catalog.chat("project", "chat").unwrap().remote.payload["deleted"],
            true
        );
    }

    #[tokio::test]
    async fn recovery_scans_once_and_verifies_pending_imports_from_that_snapshot() {
        let (_server, client, requests) = counting_server(|body| {
            if body["query"].as_str().unwrap().contains("putChatCatalog") {
                return accept(body, 2);
            }
            json!({"chatCatalog": {
                "entries": [{"chatId": "chat", "revision": 1, "payload": payload(1)}],
                "nextCursor": null
            }})
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        migration::queue(&mut catalog, "project/chat", payload(1));

        sync_project(
            &client,
            "project",
            "machine",
            &mut catalog,
            &path,
            dir.path(),
            false,
        )
        .await;
        assert_eq!(*requests.lock().unwrap(), ["scan"]);
        assert!(catalog.migration.verified.contains("project/chat"));

        // After delivering a write, verification needs an independent read-back.
        migration::queue(&mut catalog, "project/next", payload(5));
        enqueue(&mut catalog, "project", "next", payload(5));
        requests.lock().unwrap().clear();
        sync_project(
            &client,
            "project",
            "machine",
            &mut catalog,
            &path,
            dir.path(),
            false,
        )
        .await;
        assert_eq!(*requests.lock().unwrap(), ["scan", "put", "scan"]);
    }

    fn change(chat: &str, revision: u64, payload: Value) -> CatalogChange {
        CatalogChange {
            project_id: "project".into(),
            installation_id: "machine".into(),
            chat_id: chat.to_owned(),
            revision,
            payload,
        }
    }

    #[test]
    fn cdc_echoes_duplicates_and_reordered_entries_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "chat", 4, 1);
        save(&path, &catalog).unwrap();
        let before = fs::read(&path).unwrap();

        for revision in [4, 3, 0] {
            let update = apply_chat_entry(
                &mut catalog,
                &path,
                "project",
                "/repo",
                change("chat", revision, payload(8)),
            );
            assert!(update.unwrap().is_none());
        }
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "no durable write for echoes"
        );
        assert_eq!(
            catalog.chat("project", "chat").unwrap().remote.payload,
            payload(1)
        );
    }

    #[test]
    fn newer_cdc_entry_updates_cache_and_visible_summary_with_local_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "chat", 1, 1);
        catalog.sidecars.insert(
            "project/chat".into(),
            migration::Sidecar {
                project_path: Some("/repo".into()),
                association: Some(json!({"worktreePath": "local-only"})),
                gate: None,
            },
        );

        let update = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("chat", 2, payload(5)),
        )
        .unwrap()
        .unwrap();
        let session = update.session.unwrap();
        assert_eq!(update.session_id, "chat");
        assert_eq!(session.label, "chat-5");
        assert_eq!(session.project_path.as_deref(), Some("/repo"));
        assert_eq!(session.association.unwrap()["worktreePath"], "local-only");
        assert_eq!(
            load(&path)
                .unwrap()
                .chat("project", "chat")
                .unwrap()
                .remote
                .revision,
            2
        );

        // A remote creation is also merged incrementally.
        let created = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("new", 1, payload(6)),
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.session.unwrap().label, "chat-6");

        // A tombstone publishes a deletion and cannot be resurrected locally.
        let mut deleted = payload(5);
        deleted["deleted"] = json!(true);
        let update = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("chat", 3, deleted),
        )
        .unwrap()
        .unwrap();
        assert!(update.session.is_none());
        enqueue(&mut catalog, "project", "chat", payload(7));
        assert!(catalog.chat("project", "chat").unwrap().desired.is_none());
    }

    #[test]
    fn discussion_cdc_persists_transport_state_without_hydrating_regular_chat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "main", 1, 1);

        let mut discussion = payload(2);
        discussion["metadata"]["kind"] = json!("discussion");
        discussion["parent_chat_id"] = json!("main");
        discussion["review_thread_id"] = json!(Uuid::new_v4());

        let update = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("discussion", 1, discussion.clone()),
        )
        .unwrap();

        assert!(update.is_none());
        let disk = load(&path).unwrap();
        assert_eq!(
            disk.chat("project", "discussion").unwrap().remote.payload,
            discussion
        );

        let mut sessions = Vec::new();
        hydrate_snapshot(&disk, "project", "/repo", &mut sessions);
        let ids: Vec<_> = sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["main"]);
    }

    #[test]
    fn cdc_preserves_pending_local_edits_and_settles_lost_acknowledgements() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        acknowledged(&mut catalog, "project", "edited", 1, 1);
        enqueue(&mut catalog, "project", "edited", payload(2));
        acknowledged(&mut catalog, "project", "lost", 1, 1);
        enqueue(&mut catalog, "project", "lost", payload(3));
        let mutation = catalog
            .chat("project", "edited")
            .unwrap()
            .mutation_id
            .clone();

        // A concurrent remote change advances the expected revision but the
        // local intent stays visible and pending with its stable mutation id.
        let update = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("edited", 2, payload(9)),
        );
        assert!(update.unwrap().is_none());
        let record = &catalog.chat("project", "edited").unwrap();
        assert_eq!(record.desired, Some(payload(2)));
        assert_eq!(record.remote.revision, 2);
        assert_eq!(record.mutation_id, mutation);

        // The echo of a write whose acknowledgement was lost settles the outbox.
        let update = apply_chat_entry(
            &mut catalog,
            &path,
            "project",
            "/repo",
            change("lost", 2, payload(3)),
        );
        assert!(update.unwrap().is_none());
        assert!(catalog.chat("project", "lost").unwrap().desired.is_none());
        assert!(load(&path)
            .unwrap()
            .chat("project", "lost")
            .unwrap()
            .desired
            .is_none());
    }

    #[test]
    fn cdc_for_other_installations_or_unconfigured_projects_is_out_of_scope() {
        let projects = || {
            vec![crate::project_config::SavedProject {
                slug: "slug".into(),
                project_id: "project".into(),
                path: "/repo".into(),
            }]
        };
        assert!(change_scope(&change("chat", 1, payload(1)), "machine", projects()).is_some());
        assert!(
            change_scope(&change("chat", 1, payload(1)), "other-machine", projects()).is_none()
        );
        let mut foreign = change("chat", 1, payload(1));
        foreign.project_id = "elsewhere".into();
        assert!(change_scope(&foreign, "machine", projects()).is_none());
    }
}
