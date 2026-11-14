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
use vertebrae_sacrum_client::GraphqlClient;

mod migration;

static SERIAL: Mutex<()> = Mutex::const_new(());
const FIELDS: &str = "chatId revision payload updatedAt";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    chat_id: String,
    revision: u64,
    payload: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    remote: Entry,
    desired: Option<Value>,
    mutation_id: String,
    #[serde(default)]
    conflicted: bool,
    #[serde(default)]
    import_only: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    records: BTreeMap<String, Record>,
    unmapped: Vec<String>,
    #[serde(default)]
    sidecars: BTreeMap<String, migration::Sidecar>,
    #[serde(default)]
    migration: migration::Migration,
    #[serde(default)]
    annotations: BTreeMap<String, migration::AnnotationInventory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    entries: Vec<Entry>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Ack {
    status: String,
    entry: Entry,
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
    durable_write(path, &serde_json::to_vec(state).map_err(|_| error())?)?;

    let mut projects: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut pending = Vec::new();
    let mut conflicted = Vec::new();

    for (id, record) in &state.records {
        let (project, _) = id.split_once('/').ok_or_else(error)?;
        projects.entry(project.into()).or_default().push(json!({
            "chat_id": record.remote.chat_id,
            "revision": record.remote.revision,
            "payload": record.desired.as_ref().unwrap_or(&record.remote.payload)
        }));

        if record.desired.is_some() {
            pending.push(record.remote.chat_id.clone());
        }
        if record.conflicted {
            conflicted.push(record.remote.chat_id.clone());
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
        Ok(bytes) => {
            let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| error())?;
            if catalog.migration.version > migration::VERSION {
                return Err(error());
            }
            Ok(catalog)
        }
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

    json!({
        "status": session.activity_status,
        "metadata": metadata,
        "task_id": association.get("ticketId"),
        "parent_chat_id": null,
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

fn enqueue(catalog: &mut Catalog, project: &str, chat: &str, payload: Value) {
    let record = catalog
        .records
        .entry(key(project, chat))
        .or_insert_with(|| Record {
            remote: Entry {
                chat_id: chat.into(),
                revision: 0,
                payload: Value::Null,
            },
            desired: None,
            mutation_id: uuid::Uuid::new_v4().to_string(),
            conflicted: false,
            import_only: false,
        });

    if record.remote.payload["deleted"] == true
        || record
            .desired
            .as_ref()
            .is_some_and(|p| p["deleted"] == true)
    {
        return;
    }

    if record.desired.as_ref().unwrap_or(&record.remote.payload) != &payload {
        record.import_only = false;
        record.desired = Some(payload);
        record.mutation_id = uuid::Uuid::new_v4().to_string();
    }
}

fn merge(catalog: &mut Catalog, project: &str, entry: Entry) {
    let record = catalog
        .records
        .entry(key(project, &entry.chat_id))
        .or_insert_with(|| Record {
            remote: entry.clone(),
            desired: None,
            mutation_id: uuid::Uuid::new_v4().to_string(),
            conflicted: false,
            import_only: false,
        });

    if entry.revision < record.remote.revision {
        return;
    }
    if entry.payload["deleted"] == true || (record.import_only && entry.revision > 0) {
        record.desired = None;
        record.conflicted = false;
    }

    record.remote = entry;
}

async fn fetch_snapshot(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
) -> Result<BTreeMap<String, Entry>, CommandError> {
    let mut snapshot = BTreeMap::new();
    let mut seen_cursors = std::collections::BTreeSet::new();
    let mut after: Option<String> = None;

    // Read every page before replaying pending local mutations.
    loop {
        let query = format!(
            concat!(
                "query($p:Uuid4!,$m:Uuid4!,$after:String){{",
                "chatCatalog(projectId:$p,installationId:$m,after:$after,",
                "limit:100,includeCompleted:true){{entries{{{fields}}} nextCursor}}}}"
            ),
            fields = FIELDS,
        );
        let page: Page = client
            .execute(
                &query,
                json!({"p": project, "m": machine, "after": after}),
                "chatCatalog",
            )
            .await
            .map_err(|_| error())?;

        for entry in page.entries {
            if snapshot.insert(entry.chat_id.clone(), entry).is_some() {
                return Err(error());
            }
        }
        after = page.next_cursor;
        if after.is_none() {
            break;
        }
        if !seen_cursors.insert(after.clone()) {
            return Err(error());
        }
    }

    Ok(snapshot)
}

async fn exchange(
    client: &GraphqlClient,
    project: &str,
    machine: &str,
    catalog: &mut Catalog,
    path: &Path,
) -> Result<(), CommandError> {
    let snapshot = fetch_snapshot(client, project, machine).await?;
    for entry in snapshot.into_values() {
        merge(catalog, project, entry);
    }
    save(path, catalog)?;

    let prefix = format!("{project}/");
    let pending: Vec<_> = catalog
        .records
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();

    for id in pending {
        for _ in 0..2 {
            let record = catalog.records.get(&id).expect("record retained");
            let Some(payload) = record.desired.clone() else {
                break;
            };

            let mutation = record.mutation_id.clone();
            let mutation_query = format!(
                concat!(
                    "mutation($p:Uuid4!,$m:Uuid4!,$c:String!,$r:Int!,$n:Uuid4!,$v:Json!){{",
                    "putChatCatalog(projectId:$p,installationId:$m,chatId:$c,",
                    "expectedRevision:$r,mutationId:$n,payload:$v)",
                    "{{status entry{{{fields}}}}}}}"
                ),
                fields = FIELDS,
            );
            let ack: Ack = client
                .execute(
                    &mutation_query,
                    json!({
                        "p": project,
                        "m": machine,
                        "c": record.remote.chat_id,
                        "r": record.remote.revision,
                        "n": mutation,
                        "v": payload.to_string()
                    }),
                    "putChatCatalog",
                )
                .await
                .map_err(|_| error())?;

            let record = catalog.records.get_mut(&id).expect("record retained");
            if ack.status == "accepted" || ack.entry.payload["deleted"] == true {
                record.desired = None;
                record.conflicted = false;
            } else {
                record.conflicted = true;
                record.mutation_id = uuid::Uuid::new_v4().to_string();
                tracing::info!(
                    chat_id = %record.remote.chat_id,
                    "chat_catalog_conflict"
                );
            }

            record.remote = ack.entry;
            tracing::info!(
                chat_id = %record.remote.chat_id,
                revision = record.remote.revision,
                pending = record.desired.is_some(),
                imported = record.import_only,
                "chat_catalog_ack"
            );
            save(path, catalog)?;
        }
    }
    Ok(())
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

/// Persist pending changes before attempting network IO. A failed exchange is
/// recoverable on the next save/load and never discards the local snapshot.
pub(super) async fn synchronize(
    state: &AppState,
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
    editing: bool,
    deleted_ids: &[String],
    changed_ids: Option<&[String]>,
) -> Result<(), CommandError> {
    let _guard = SERIAL.lock().await;
    let client = state.sacrum_client.read().await.clone();
    let Some(client) = client else {
        return Ok(());
    };

    let root = root()?;
    let _disk_guard = lock_file(&root, ".chat-catalog.lock")?;
    let machine = installation(&root)?;
    let identity = scope_identity(&root, &client, &machine, true).await?;
    let path = state_path(&root, &identity);
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
        let local: Vec<_> = sessions
            .iter()
            .filter(|s| s.project_path.as_deref() == Some(project.path.as_str()))
            .collect();

        // Queue explicit edits and previously unseen legacy sessions.
        for session in &local {
            let id = key(&project.project_id, &session.id);
            catalog.annotations.insert(
                id.clone(),
                migration::inventory_annotations(&root, &session.id)
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
            if let Some(record) = catalog.records.get(&id) {
                import_payload["classifications"] =
                    record.desired.as_ref().unwrap_or(&record.remote.payload)["classifications"]
                        .clone();
            }
            migration::queue(&mut catalog, &id, import_payload);

            if (editing && changed_ids.is_none_or(|ids| ids.contains(&session.id)))
                || !catalog.records.contains_key(&id)
            {
                let mut payload = projection(session);
                if let Some(record) = catalog.records.get(&id) {
                    payload["classifications"] =
                        record.desired.as_ref().unwrap_or(&record.remote.payload)
                            ["classifications"]
                            .clone();
                }
                let absent = !catalog.records.contains_key(&id);
                enqueue(&mut catalog, &project.project_id, &session.id, payload);
                if absent {
                    catalog.records.get_mut(&id).expect("enqueued").import_only =
                        !editing || changed_ids.is_some_and(|ids| !ids.contains(&session.id));
                }
            }
        }

        // Only explicit deletions create tombstones.
        if editing {
            let prefix = format!("{}/", project.project_id);
            let removed: Vec<_> = catalog
                .records
                .iter()
                .filter(|(k, r)| k.starts_with(&prefix) && deleted_ids.contains(&r.remote.chat_id))
                .map(|(_, r)| r.remote.chat_id.clone())
                .collect();
            for id in removed {
                let mut payload = catalog.records[&key(&project.project_id, &id)]
                    .desired
                    .as_ref()
                    .unwrap_or(
                        &catalog.records[&key(&project.project_id, &id)]
                            .remote
                            .payload,
                    )
                    .clone();
                payload["deleted"] = json!(true);
                payload["status"] = json!("idle");
                enqueue(&mut catalog, &project.project_id, &id, payload);
            }
        }

        save(&path, &catalog)?;
        if exchange(&client, &project.project_id, &machine, &mut catalog, &path)
            .await
            .is_err()
        {
            tracing::info!(
                pending = catalog
                    .records
                    .values()
                    .filter(|r| r.desired.is_some())
                    .count(),
                unmapped = catalog.unmapped.len(),
                "chat_catalog_offline"
            );
        }

        if migration::finish(
            &client,
            &project.project_id,
            &machine,
            &mut catalog,
            &path,
            &root,
        )
        .await
        .is_err()
        {
            tracing::info!("chat_catalog_migration_pending");
        }

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

        // Rebuild visible summaries while retaining local-only sidecars.
        if !editing {
            hydrate_snapshot(&catalog, &project.project_id, &project.path, sessions);
        }
    }
    Ok(())
}

fn hydrate_snapshot(
    catalog: &Catalog,
    project_id: &str,
    project_path: &str,
    sessions: &mut Vec<LocalChatSessionIndexEntry>,
) {
    let prefix = format!("{project_id}/");
    for (id, record) in &catalog.records {
        if !id.starts_with(&prefix) {
            continue;
        }

        let payload = record.desired.as_ref().unwrap_or(&record.remote.payload);
        if payload["deleted"] == true {
            sessions.retain(|s| s.id != record.remote.chat_id);
            continue;
        }

        let previous = sessions
            .iter()
            .find(|s| s.id == record.remote.chat_id)
            .cloned();
        let mut value = payload["metadata"].clone();
        value["activityStatus"] = payload
            .get("status")
            .cloned()
            .unwrap_or_else(|| json!("idle"));
        value["id"] = json!(record.remote.chat_id);
        value["projectPath"] = json!(project_path);
        let sidecar = catalog.sidecars.get(id);
        value["gate"] = previous
            .as_ref()
            .and_then(|s| s.gate.as_ref())
            .or_else(|| sidecar.and_then(|s| s.gate.as_ref()))
            .map(|g| serde_json::to_value(g).unwrap())
            .unwrap_or(Value::Null);

        let mut association = previous
            .as_ref()
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

        if let Ok(session) = serde_json::from_value(value) {
            sessions.retain(|s| s.id != record.remote.chat_id);
            sessions.push(session);
        }
    }
}

/// Return true when backend persistence handled the write. Do not recreate
/// already retired legacy rows on subsequent saves, including offline edits.
pub(super) async fn save_pending_legacy(
    state: &AppState,
    path: &Path,
    mut sessions: Vec<LocalChatSessionIndexEntry>,
) -> Result<bool, CommandError> {
    let _guard = SERIAL.lock().await;
    let client = state.sacrum_client.read().await.clone();
    let Some(client) = client else {
        return Ok(false);
    };
    let root = root()?;
    let _disk_guard = lock_file(&root, ".chat-catalog.lock")?;
    let machine = installation(&root)?;
    let identity = scope_identity(&root, &client, &machine, false).await?;
    let catalog = load(&state_path(&root, &identity))?;
    sessions.retain(|session| !migration::can_retire(&catalog, session));

    if sessions.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => fs::File::open(&root)
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
    let _guard = SERIAL.lock().await;
    let client = state.sacrum_client.read().await.clone();
    let Some(client) = client else {
        return Ok(());
    };

    let root = root()?;
    let _disk_guard = lock_file(&root, ".chat-catalog.lock")?;
    let machine = installation(&root)?;
    let scope = scope_identity(&root, &client, &machine, false).await?;
    let ownership: BTreeMap<String, String> = serde_json::from_slice(
        &fs::read(root.join("chat-catalog-ownership.json")).map_err(|_| error())?,
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

async fn classification_context(
    state: &AppState,
    project_path: &str,
) -> Result<
    (
        std::sync::Arc<GraphqlClient>,
        String,
        std::path::PathBuf,
        String,
        fs::File,
    ),
    CommandError,
> {
    let client = state.sacrum_client.read().await.clone().ok_or_else(error)?;
    let project = state
        .project_config
        .get_projects()
        .into_iter()
        .find(|p| p.path == project_path)
        .ok_or_else(error)?;
    let root = root()?;
    let _disk_guard = lock_file(&root, ".chat-catalog.lock")?;
    let machine = installation(&root)?;
    let identity = scope_identity(&root, &client, &machine, false).await?;
    let path = state_path(&root, &identity);
    Ok((client, project.project_id, path, machine, _disk_guard))
}

pub(super) async fn load_classifications(
    state: &AppState,
    project_path: &str,
    chat_id: &str,
) -> Result<Vec<super::tool_activity::Classification>, CommandError> {
    let _guard = SERIAL.lock().await;
    let (_, project, path, _, _disk_guard) = classification_context(state, project_path).await?;
    let catalog = load(&path)?;
    let record = catalog
        .records
        .get(&key(&project, chat_id))
        .ok_or_else(error)?;
    let payload = record.desired.as_ref().unwrap_or(&record.remote.payload);
    if payload["deleted"] == true {
        return Err(error());
    }

    serde_json::from_value(payload["classifications"].clone()).map_err(|_| error())
}

pub(super) async fn store_classifications(
    state: &AppState,
    project_path: &str,
    chat_id: &str,
    classifications: Vec<super::tool_activity::Classification>,
    expected_connection: &str,
) -> Result<(), CommandError> {
    let _guard = SERIAL.lock().await;
    let (client, project, path, machine, _disk_guard) =
        classification_context(state, project_path).await?;
    if client.connection_identity() != expected_connection {
        return Err(error());
    }

    let mut catalog = load(&path)?;
    let record = catalog
        .records
        .get(&key(&project, chat_id))
        .ok_or_else(error)?;
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

    payload["classifications"] = serde_json::to_value(all).map_err(|_| error())?;
    enqueue(&mut catalog, &project, chat_id, payload);
    save(&path, &catalog)?;
    let _ = exchange(&client, &project, &machine, &mut catalog, &path).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::{generators as gs, TestCase};
    use vertebrae_sacrum_client::SacrumConfig;
    use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

    fn payload(n: u8) -> Value {
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

        assert_ne!(
            scope_identity(dir.path(), &client("account-b"), "machine", true)
                .await
                .unwrap(),
            original
        );

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
        data["classifications"] = json!([
            {
                "tool_id": "c".repeat(64),
                "input_hash": "a".repeat(64),
                "classifier_fingerprint": "b".repeat(64),
                "labels": []
            }
        ]);
        enqueue(&mut catalog, &project, &chat, data.clone());
        save(&path, &catalog).unwrap();

        exchange(&client, &project, &machine, &mut catalog, &path)
            .await
            .unwrap();
        let id = key(&project, &chat);
        assert!(catalog.records[&id].desired.is_none());
        assert_eq!(catalog.records[&id].remote.payload, data);

        let mut restarted = load(&path).unwrap();

        exchange(&client, &project, &machine, &mut restarted, &path)
            .await
            .unwrap();
        assert_eq!(restarted.records[&id].remote.payload, data);
        assert_eq!(restarted.records[&id].remote.revision, 1);

        data["deleted"] = json!(true);
        enqueue(&mut restarted, &project, &chat, data);
        save(&path, &restarted).unwrap();

        exchange(&client, &project, &machine, &mut restarted, &path)
            .await
            .unwrap();
        enqueue(&mut restarted, &project, &chat, payload(22));
        assert!(restarted.records[&id].desired.is_none());
        assert_eq!(restarted.records[&id].remote.payload["deleted"], true);
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
        catalog.records.get_mut("project/chat").unwrap().import_only = true;

        let mut canonical = payload(9);
        canonical["classifications"] = json!([{"labels": []}]);
        merge(
            &mut catalog,
            "project",
            Entry {
                chat_id: "chat".into(),
                revision: 7,
                payload: canonical.clone(),
            },
        );

        assert!(catalog.records["project/chat"].desired.is_none());
        assert_eq!(catalog.records["project/chat"].remote.payload, canonical);
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
            .expect(3)
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

        assert!(catalog.records["project/chat"].desired.is_none());
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
            let id = key(&p, &c);

            match operation {
                0..=2 => {
                    if expected.get(&(project, chat)) != Some(&None) {
                        expected.insert((project, chat), Some(value));
                    }
                    enqueue(&mut state, &p, &c, payload(value));
                }
                3 => {
                    // deletion, including offline/imported records
                    if expected.contains_key(&(project, chat)) {
                        expected.insert((project, chat), None);
                        let record = &state.records[&id];
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
                    state = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
                }
                5 => {
                    // delivery and ack, then duplicated/reordered older event
                    if let Some(record) = state.records.get_mut(&id) {
                        if let Some(desired) = record.desired.take() {
                            revision += 1;
                            record.remote = Entry {
                                chat_id: c.clone(),
                                revision,
                                payload: desired,
                            };
                        }
                        let current = record.remote.clone();
                        merge(&mut state, &p, current);
                        if revision > 0 {
                            merge(
                                &mut state,
                                &p,
                                Entry {
                                    chat_id: c.clone(),
                                    revision: 0,
                                    payload: payload(0),
                                },
                            );
                        }
                    }
                }
                _ => {
                    // remote delete racing a pending inference or manual correction
                    if state.records.contains_key(&id) {
                        revision += 1;
                        expected.insert((project, chat), None);
                        let mut deleted = payload(0);
                        deleted["deleted"] = json!(true);
                        merge(
                            &mut state,
                            &p,
                            Entry {
                                chat_id: c,
                                revision,
                                payload: deleted,
                            },
                        );
                    }
                }
            }

            for ((project, chat), intent) in &expected {
                let record = &state.records[&key(&project.to_string(), &chat.to_string())];
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
            .expect(3)
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
            catalog.records.keys().cloned().collect::<Vec<_>>(),
            ["project/a", "project/b", "project/c"]
        );
        assert_eq!(load(&path).unwrap().records.len(), 3);
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
                                "chatId": entry.chat_id,
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
                        chat_id: vars["c"].as_str().unwrap().into(),
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
                                "chatId": row.chat_id,
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
        let mutation = catalog.records["project/chat"].mutation_id.clone();
        assert!(exchange(&client, "project", "machine", &mut catalog, &path)
            .await
            .is_err());

        let mut restarted = load(&path).unwrap();
        assert_eq!(restarted.records["project/chat"].mutation_id, mutation);

        exchange(&client, "project", "machine", &mut restarted, &path)
            .await
            .unwrap();
        assert!(restarted.records["project/chat"].desired.is_none());
        assert_eq!(restarted.records["project/chat"].remote.revision, 1);

        let expected: Value =
            serde_json::from_slice(&fs::read(path.with_extension("expected.json")).unwrap())
                .unwrap();
        assert_eq!(expected["pending"], json!([]));
        assert_eq!(expected["projects"][0]["entries"][0]["payload"], payload(7));
    }
}
