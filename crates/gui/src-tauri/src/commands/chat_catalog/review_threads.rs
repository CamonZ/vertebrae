use super::*;
use tauri::{AppHandle, Emitter, Runtime, State};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReviewThreadSide {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewThreadHome {
    Worktree,
    ToolCall,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewThreadStatus {
    Open,
    Outdated,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewThreadOrigin {
    Local,
}

/// Complete anchor and current position. Snake-case aliases decode Sacrum rows;
/// the desktop IPC contract uses camelCase.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadInput {
    #[serde(alias = "parent_chat_id")]
    pub parent_chat_id: String,
    pub path: String,
    pub side: ReviewThreadSide,
    #[serde(alias = "home_kind")]
    pub home_kind: ReviewThreadHome,
    #[serde(alias = "tool_use_id")]
    pub tool_use_id: Option<String>,
    #[serde(alias = "original_commit_id")]
    pub original_commit_id: String,
    #[serde(alias = "original_blob_id")]
    pub original_blob_id: String,
    #[serde(alias = "original_start_line")]
    pub original_start_line: u32,
    #[serde(alias = "original_line")]
    pub original_line: u32,
    #[serde(alias = "start_line")]
    pub start_line: Option<u32>,
    pub line: Option<u32>,
    pub status: ReviewThreadStatus,
    #[serde(alias = "outdated_noted")]
    pub outdated_noted: bool,
    #[serde(alias = "origin_kind")]
    pub origin_kind: ReviewThreadOrigin,
    #[serde(alias = "origin_ref")]
    pub origin_ref: Option<String>,
}

impl ReviewThreadInput {
    fn into_wire(self) -> Value {
        json!({
            "parent_chat_id": self.parent_chat_id,
            "path": self.path,
            "side": self.side,
            "home_kind": self.home_kind,
            "tool_use_id": self.tool_use_id,
            "original_commit_id": self.original_commit_id,
            "original_blob_id": self.original_blob_id,
            "original_start_line": self.original_start_line,
            "original_line": self.original_line,
            "start_line": self.start_line,
            "line": self.line,
            "status": self.status,
            "outdated_noted": self.outdated_noted,
            "origin_kind": self.origin_kind,
            "origin_ref": self.origin_ref,
            "deleted": false,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub thread_id: Uuid,
    pub revision: u32,
    pub payload: ReviewThreadInput,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadChanged {
    pub project_id: String,
    pub thread_id: Uuid,
    pub thread: Option<ReviewThread>,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadCatalogRecovered {
    pub project_id: String,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadCatalogRecoveryNeeded {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ReviewThreadChange {
    pub project_id: String,
    pub installation_id: String,
    pub thread_id: Uuid,
    pub revision: u64,
    pub payload: Value,
}

fn visible_thread(id: Uuid, record: &Record) -> Option<ReviewThread> {
    if record.tombstoned() {
        return None;
    }

    let revision = u32::try_from(record.remote.revision).ok()?;
    let payload = serde_json::from_value(record.visible().clone()).ok()?;
    Some(ReviewThread {
        thread_id: id,
        revision,
        payload,
    })
}

pub(super) fn thread_views(catalog: &Catalog, project: &str) -> BTreeMap<Uuid, ReviewThread> {
    catalog
        .records(project)
        .filter_map(|(id, record)| match id {
            EntityKey::Chat(_) => None,
            EntityKey::Thread(ThreadId(id)) => visible_thread(*id, record).map(|view| (*id, view)),
        })
        .collect()
}

pub(super) fn publish_thread_changes<R: Runtime>(
    app: &AppHandle<R>,
    project: &str,
    mut before: BTreeMap<Uuid, ReviewThread>,
    catalog: &Catalog,
) {
    let publish = |thread_id, thread| {
        let _ = app.emit(
            "review-thread-changed",
            ReviewThreadChanged {
                project_id: project.into(),
                thread_id,
                thread,
            },
        );
    };

    for (id, thread) in thread_views(catalog, project) {
        if before.remove(&id).as_ref() != Some(&thread) {
            publish(id, Some(thread));
        }
    }
    for id in before.into_keys() {
        publish(id, None);
    }
}

pub(super) fn publish_thread_recovered<R: Runtime>(app: &AppHandle<R>, project: &str) {
    let _ = app.emit(
        "review-thread-catalog-recovered",
        ReviewThreadCatalogRecovered {
            project_id: project.into(),
        },
    );
}

pub(crate) async fn apply_review_thread_change<R: Runtime>(
    state: &AppState,
    app: &AppHandle<R>,
    change: ReviewThreadChange,
    deleted: bool,
) -> Result<(), CommandError> {
    let Some(access) = CatalogAccess::open(state).await? else {
        return Ok(());
    };
    if change.installation_id != access.machine
        || configured_project(state.project_config.get_projects(), &change.project_id).is_none()
    {
        return Ok(());
    }
    let Ok(path) = access.path(false).await else {
        return Ok(());
    };
    let mut catalog = load(&path)?;

    let mut payload = change.payload;
    let fields = payload.as_object_mut().ok_or_else(error)?;
    if deleted {
        fields.insert("deleted".into(), json!(true));
    } else {
        serde_json::from_value::<ReviewThreadInput>(payload.clone()).map_err(|_| error())?;
    }
    u32::try_from(change.revision).map_err(|_| error())?;

    let before = thread_views(&catalog, &change.project_id);
    apply_entry(
        &mut catalog,
        &path,
        &change.project_id,
        Entry {
            id: EntityKey::Thread(ThreadId(change.thread_id)),
            revision: change.revision,
            payload,
        },
    )?;

    publish_thread_changes(app, &change.project_id, before, &catalog);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_review_threads(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ReviewThread>, CommandError> {
    let Some(access) = CatalogAccess::open(&state).await? else {
        return Ok(Vec::new());
    };
    if configured_project(state.project_config.get_projects(), &project_id).is_none() {
        return Ok(Vec::new());
    }
    let Ok(path) = access.path(false).await else {
        return Ok(Vec::new());
    };
    Ok(thread_views(&load(&path)?, &project_id)
        .into_values()
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn put_review_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    thread_id: Uuid,
    payload: ReviewThreadInput,
) -> Result<(), CommandError> {
    write_thread(&app, &state, &project_id, thread_id, move |current| {
        if current.is_some_and(Record::tombstoned) {
            return Err(thread_error("Review thread has been deleted."));
        }
        Ok(Some(payload.into_wire()))
    })
    .await
}

/// A known tombstone makes deletion idempotent. An unknown ID is an error.
#[tauri::command]
#[specta::specta]
pub async fn tombstone_review_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    thread_id: Uuid,
) -> Result<(), CommandError> {
    write_thread(&app, &state, &project_id, thread_id, |current| {
        let current = current.ok_or_else(|| thread_error("Review thread was not found."))?;
        if current.tombstoned() {
            return Ok(None);
        }

        let mut payload = current.visible().clone();
        payload
            .as_object_mut()
            .ok_or_else(error)?
            .insert("deleted".into(), json!(true));
        Ok(Some(payload))
    })
    .await
}

fn thread_error(message: &str) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

async fn write_thread(
    app: &AppHandle,
    state: &AppState,
    project: &str,
    id: Uuid,
    edit: impl FnOnce(Option<&Record>) -> Result<Option<Value>, CommandError>,
) -> Result<(), CommandError> {
    if configured_project(state.project_config.get_projects(), project).is_none() {
        return Err(error());
    }

    let access = CatalogAccess::open(state).await?.ok_or_else(error)?;

    // Startup recovery authenticates and resolves the account before writes.
    // A thread write never makes a network request until its intent is on disk.
    let path = access.path(false).await?;
    let mut catalog = load(&path)?;
    let id = EntityKey::Thread(ThreadId(id));

    let Some(payload) = edit(catalog.record(project, &id))? else {
        return Ok(());
    };
    if delivery::parent_deleted(&catalog, project, &id, &payload) {
        return Err(thread_error("The parent chat has been deleted."));
    }

    let before = thread_views(&catalog, project);
    enqueue_entity(&mut catalog, project, &id, payload);
    save(&path, &catalog)?;

    // Reconnect replays transport failures with the same durable mutation ID.
    if deliver(
        &access.client,
        project,
        &access.machine,
        &mut catalog,
        &path,
    )
    .await
    .is_err()
    {
        tracing::info!(project_id = project, "review_thread_catalog_offline");
        catalog = load(&path)?;
    }

    publish_thread_changes(app, project, before, &catalog);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_sacrum_client::SacrumConfig;
    use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

    #[test]
    fn thread_ipc_uses_camel_case_and_maps_explicit_nulls_to_sacrum() {
        let ipc = json!({
            "parentChatId": "chat",
            "path": "file.rs",
            "side": "LEFT",
            "homeKind": "tool_call",
            "toolUseId": "tool-call",
            "originalCommitId": "abc",
            "originalBlobId": "def",
            "originalStartLine": 1,
            "originalLine": 2,
            "startLine": null,
            "line": null,
            "status": "outdated",
            "outdatedNoted": true,
            "originKind": "local",
            "originRef": null,
        });

        let input: ReviewThreadInput = serde_json::from_value(ipc.clone()).unwrap();
        let wire = input.into_wire();

        assert_eq!(
            wire,
            json!({
                "parent_chat_id": "chat",
                "path": "file.rs",
                "side": "LEFT",
                "home_kind": "tool_call",
                "tool_use_id": "tool-call",
                "original_commit_id": "abc",
                "original_blob_id": "def",
                "original_start_line": 1,
                "original_line": 2,
                "start_line": null,
                "line": null,
                "status": "outdated",
                "outdated_noted": true,
                "origin_kind": "local",
                "origin_ref": null,
                "deleted": false,
            })
        );

        let decoded: ReviewThreadInput = serde_json::from_value(wire).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), ipc);
    }

    #[tokio::test]
    async fn recovery_restores_paginated_threads_and_ignores_stale_or_duplicate_events() {
        let live = Uuid::new_v4();
        let deleted = Uuid::new_v4();
        let server = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let query = body["query"].as_str().unwrap();
                if query.contains("chatCatalog(") {
                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": {"chatCatalog": {"entries": [], "nextCursor": null}}
                    }));
                }

                assert!(query.contains("reviewThreads(") && query.contains("$after:Uuid4"));
                let (id, cursor, deleted) = match body["variables"]["after"].as_str() {
                    None => (live, Some(live), false),
                    Some(cursor) if cursor == live.to_string() => (deleted, None, true),
                    _ => panic!("unexpected reviewThreads cursor"),
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": {"reviewThreads": {"entries": [{
                        "threadId": id,
                        "revision": 2,
                        "payload": {"parent_chat_id": "parent", "deleted": deleted}
                    }], "nextCursor": cursor}}
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
        let mut catalog = load(&path).unwrap();

        exchange(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap();

        let mut recovered = load(&path).unwrap();
        let live = EntityKey::Thread(ThreadId(live));
        let deleted = EntityKey::Thread(ThreadId(deleted));
        assert_eq!(
            recovered.record("project", &live).unwrap().remote.revision,
            2
        );
        assert!(recovered.record("project", &deleted).unwrap().tombstoned());

        let before = fs::read(&path).unwrap();
        for (id, revision) in [(live.clone(), 1), (live, 2), (deleted.clone(), 3)] {
            assert!(!apply_entry(
                &mut recovered,
                &path,
                "project",
                Entry {
                    id,
                    revision,
                    payload: json!({"parent_chat_id": "parent", "deleted": false, "path": "stale"}),
                },
            )
            .unwrap());
        }
        assert_eq!(fs::read(&path).unwrap(), before);

        enqueue_entity(
            &mut recovered,
            "project",
            &deleted,
            json!({"deleted": false}),
        );
        assert!(recovered
            .record("project", &deleted)
            .unwrap()
            .desired
            .is_none());
    }
}
