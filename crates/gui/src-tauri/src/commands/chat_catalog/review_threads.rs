use super::*;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    pub(super) fn into_wire(self) -> Value {
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
    pub checkout_path: Option<String>,
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

fn visible_thread(
    catalog: &Catalog,
    project: &str,
    id: Uuid,
    record: &Record,
) -> Option<ReviewThread> {
    if record.tombstoned() {
        return None;
    }

    let revision = u32::try_from(record.remote.revision).ok()?;
    let payload = serde_json::from_value(record.visible().clone()).ok()?;
    Some(ReviewThread {
        thread_id: id,
        revision,
        checkout_path: catalog
            .anchor_checkouts
            .get(project)
            .and_then(|paths| paths.get(&id))
            .cloned(),
        payload,
    })
}

pub(super) fn thread_views(catalog: &Catalog, project: &str) -> BTreeMap<Uuid, ReviewThread> {
    catalog
        .records(project)
        .filter_map(|(id, record)| match id {
            EntityKey::Chat(_) => None,
            EntityKey::Thread(ThreadId(id)) => {
                visible_thread(catalog, project, *id, record).map(|view| (*id, view))
            }
        })
        .collect()
}

pub(super) struct ThreadChanges {
    visible: BTreeMap<Uuid, ReviewThread>,
    // Acknowledged tombstones and unsent local children discarded when
    // their parent deletion was acknowledged.
    acknowledged: std::collections::BTreeSet<Uuid>,
}

pub(super) fn thread_changes(catalog: &Catalog, project: &str) -> ThreadChanges {
    ThreadChanges {
        visible: thread_views(catalog, project),
        acknowledged: catalog
            .anchor_repositories
            .get(project)
            .into_iter()
            .flat_map(|paths| paths.keys().copied())
            .filter(|id| {
                catalog
                    .record(project, &EntityKey::Thread(ThreadId(*id)))
                    .is_none_or(|record| record.remote.payload["deleted"] == true)
            })
            .collect(),
    }
}

pub(super) async fn publish_thread_changes<R: Runtime>(
    app: &AppHandle<R>,
    project: &str,
    path: &Path,
    before: ThreadChanges,
    catalog: &mut Catalog,
) {
    let after = thread_changes(catalog, project);
    let released: Vec<_> = after
        .acknowledged
        .difference(&before.acknowledged)
        .copied()
        .collect();
    release_anchors(catalog, project, path, released).await;

    publish_thread_delta(app, project, before.visible, after.visible);
}

fn publish_thread<R: Runtime>(
    app: &AppHandle<R>,
    project: &str,
    thread_id: Uuid,
    thread: Option<ReviewThread>,
) {
    let _ = app.emit(
        "review-thread-changed",
        ReviewThreadChanged {
            project_id: project.into(),
            thread_id,
            thread,
        },
    );
}

fn publish_thread_delta<R: Runtime>(
    app: &AppHandle<R>,
    project: &str,
    mut visible: BTreeMap<Uuid, ReviewThread>,
    after: BTreeMap<Uuid, ReviewThread>,
) {
    for (id, thread) in after {
        if visible.remove(&id).as_ref() != Some(&thread) {
            publish_thread(app, project, id, Some(thread));
        }
    }
    for id in visible.into_keys() {
        publish_thread(app, project, id, None);
    }
}

async fn release_anchors(catalog: &mut Catalog, project: &str, path: &Path, threads: Vec<Uuid>) {
    let Some(repositories) = catalog.anchor_repositories.get_mut(project) else {
        return;
    };
    let mut by_repository = BTreeMap::<_, Vec<_>>::new();
    for id in threads {
        if let Some(directory) = repositories.get(&id) {
            by_repository.entry(directory.clone()).or_default().push(id);
        }
    }
    if by_repository.is_empty() {
        return;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut released = Vec::new();
        for (directory, ids) in by_repository {
            let repo = match git2::Repository::open(directory) {
                Ok(repo) => repo,
                Err(error) => {
                    tracing::warn!(code = ?error.code(), "review_anchor_repository_unavailable");
                    continue;
                }
            };
            for id in ids {
                match super::review_anchors::release(&repo, id) {
                    Ok(()) => released.push(id),
                    Err(error) => tracing::warn!(thread_id = %id, code = ?error.code(), "review_anchor_release_failed"),
                }
            }
        }
        released
    }).await;
    match result {
        Ok(released) if !released.is_empty() => {
            let checkouts = catalog.anchor_checkouts.get_mut(project);
            for id in released {
                repositories.remove(&id);
            }
            if let Some(checkouts) = checkouts {
                checkouts.retain(|id, _| repositories.contains_key(id));
                if checkouts.is_empty() {
                    catalog.anchor_checkouts.remove(project);
                }
            }
            if repositories.is_empty() {
                catalog.anchor_repositories.remove(project);
            }
            // Only the authoritative catalog contains the local Git directory
            // index. The public diagnostic projections are unchanged.
            if storage::encode(catalog)
                .and_then(|bytes| durable_write(path, &bytes))
                .is_err()
            {
                tracing::warn!(project_id = project, "review_anchor_cleanup_save_failed");
            }
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "review_anchor_cleanup_failed"),
    }
}

/// A crash after deleting a ref can leave its index entry; release is
/// idempotent and the next recovery prunes it.
pub(super) async fn recover_anchor_cleanup(catalog: &mut Catalog, project: &str, path: &Path) {
    let threads = thread_changes(catalog, project)
        .acknowledged
        .into_iter()
        .collect();
    release_anchors(catalog, project, path, threads).await;
}

pub(super) fn publish_thread_recovered<R: Runtime>(app: &AppHandle<R>, project: &str) {
    let _ = app.emit(
        "review-thread-catalog-recovered",
        ReviewThreadCatalogRecovered {
            project_id: project.into(),
        },
    );
}

type ObservedThread = (std::path::PathBuf, String, Uuid);
const RECENT_THREAD_REVISIONS: usize = 1024;

#[derive(Default)]
pub(crate) struct ReviewThreadObservations(std::sync::Mutex<RecentThreadRevisions>);

#[derive(Default)]
struct RecentThreadRevisions(std::collections::VecDeque<(ObservedThread, u64)>);

impl RecentThreadRevisions {
    fn apply(
        &mut self,
        key: ObservedThread,
        revision: u64,
        cached_revision: Option<u64>,
        merge: impl FnOnce() -> Result<(), CommandError>,
    ) -> Result<bool, CommandError> {
        let previous = self.0.iter().position(|(seen, _)| *seen == key);
        if previous.is_some_and(|index| self.0[index].1 >= revision)
            && cached_revision.is_some_and(|cached| cached >= revision)
        {
            return Ok(false);
        }
        merge()?;
        if let Some(index) = previous {
            self.0.remove(index);
        }
        if self.0.len() == RECENT_THREAD_REVISIONS {
            self.0.pop_front();
        }
        self.0.push_back((key, revision));
        Ok(true)
    }
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
    if change.installation_id != access.machine {
        return Ok(());
    }
    if configured_project(state.project_config.get_projects(), &change.project_id).is_none() {
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

    let id = EntityKey::Thread(ThreadId(change.thread_id));
    let cached_revision = catalog
        .record(&change.project_id, &id)
        .map(|record| record.remote.revision);
    let before = thread_changes(&catalog, &change.project_id);
    let observations = app.state::<ReviewThreadObservations>();
    let applied = observations
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .apply(
            (path.clone(), change.project_id.clone(), change.thread_id),
            change.revision,
            cached_revision,
            || {
                apply_entry(
                    &mut catalog,
                    &path,
                    &change.project_id,
                    Entry {
                        id,
                        revision: change.revision,
                        payload,
                    },
                )?;
                Ok(())
            },
        )?;
    if !applied {
        return Ok(());
    }

    // Another GUI process can have already written the same CDC row into
    // our shared catalog. Its write doesn't notify this process's webview.
    if let Some(thread) =
        shared_thread_notification(&before, &catalog, &change.project_id, change.thread_id)
    {
        publish_thread(app, &change.project_id, change.thread_id, thread);
    }
    publish_thread_changes(app, &change.project_id, &path, before, &mut catalog).await;
    Ok(())
}

fn shared_thread_notification(
    before: &ThreadChanges,
    catalog: &Catalog,
    project: &str,
    id: Uuid,
) -> Option<Option<ReviewThread>> {
    let visible = catalog
        .record(project, &EntityKey::Thread(ThreadId(id)))
        .and_then(|record| visible_thread(catalog, project, id, record));
    (before.visible.get(&id) == visible.as_ref()).then_some(visible)
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

#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReviewThreadUpdate {
    Position { position: ReviewThreadPosition },
    OutdatedNote,
    Anchor { anchor: ReviewThreadInput },
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewThreadPosition {
    status: ReviewThreadStatus,
    start_line: Option<u32>,
    line: Option<u32>,
}

fn edit_review_thread(
    current: Option<&Record>,
    update: ReviewThreadUpdate,
) -> Result<Option<Value>, CommandError> {
    let Some(record) = current else {
        return match update {
            ReviewThreadUpdate::Anchor { anchor } => Ok(Some(anchor.into_wire())),
            _ => Err(thread_error("Review thread was not found.")),
        };
    };
    if record.tombstoned() {
        return Err(thread_error("Review thread has been deleted."));
    }
    let mut stored: ReviewThreadInput = serde_json::from_value(record.visible().clone())
        .map_err(|_| thread_error("The saved review thread is corrupt."))?;
    let previous = stored.clone();
    match update {
        ReviewThreadUpdate::OutdatedNote => stored.outdated_noted = true,
        ReviewThreadUpdate::Position { position } => {
            stored.status = position.status;
            stored.start_line = position.start_line;
            stored.line = position.line;
        }
        ReviewThreadUpdate::Anchor { .. } => {
            return Err(thread_error("The captured review anchor is immutable."));
        }
    }
    Ok((stored != previous).then(|| stored.into_wire()))
}

#[tauri::command]
#[specta::specta]
pub async fn put_review_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    thread_id: Uuid,
    payload: ReviewThreadUpdate,
) -> Result<(), CommandError> {
    write_thread(&app, &state, &project_id, thread_id, move |current| {
        edit_review_thread(current, payload)
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

pub(super) struct ThreadWrite {
    access: CatalogAccess,
    path: std::path::PathBuf,
    catalog: Catalog,
    project: String,
    id: EntityKey,
    anchor_repository: Option<(std::path::PathBuf, String)>,
}

impl ThreadWrite {
    pub(super) async fn open(
        state: &AppState,
        project: &str,
        id: Uuid,
    ) -> Result<Self, CommandError> {
        configured_project(state.project_config.get_projects(), project).ok_or_else(error)?;
        let access = CatalogAccess::open(state).await?.ok_or_else(error)?;
        let path = access.path(false).await?;
        let catalog = load(&path)?;
        Ok(Self {
            access,
            path,
            catalog,
            project: project.into(),
            id: EntityKey::Thread(ThreadId(id)),
            anchor_repository: None,
        })
    }

    pub(super) fn can_create(&self, parent: &str) -> bool {
        self.catalog.record(&self.project, &self.id).is_none()
            && self
                .catalog
                .chat(&self.project, parent)
                .is_some_and(|record| !record.tombstoned())
    }

    pub(super) fn retain_in(&mut self, common_dir: std::path::PathBuf, checkout: String) {
        self.anchor_repository = Some((common_dir, checkout));
    }

    /// A failed save can occur after activation. Release a staged ref only
    /// after confirming that this exact catalog has no record for the thread.
    pub(super) fn registration_absent(&self) -> bool {
        load(&self.path).is_ok_and(|catalog| catalog.record(&self.project, &self.id).is_none())
    }

    pub(super) async fn persist(
        &mut self,
        app: &AppHandle,
        payload: Value,
    ) -> Result<(), CommandError> {
        let project = &self.project;
        let catalog = &mut self.catalog;
        if delivery::parent_deleted(catalog, project, &self.id, &payload) {
            return Err(thread_error("The parent chat has been deleted."));
        }
        let before = thread_changes(catalog, project);
        enqueue_entity(catalog, project, &self.id, payload);
        if let (EntityKey::Thread(ThreadId(id)), Some((path, checkout))) =
            (&self.id, self.anchor_repository.take())
        {
            catalog
                .anchor_repositories
                .entry(project.clone())
                .or_default()
                .insert(*id, path);
            catalog
                .anchor_checkouts
                .entry(project.clone())
                .or_default()
                .insert(*id, checkout);
        }
        save(&self.path, catalog)?;
        let queued = thread_views(catalog, project);

        // Reconnect replays transport failures with the same durable mutation ID.
        if deliver(
            &self.access.client,
            project,
            &self.access.machine,
            catalog,
            &self.path,
        )
        .await
        .is_err()
        {
            tracing::info!(project_id = project, "review_thread_catalog_offline");
            if let Ok(durable) = load(&self.path) {
                *catalog = durable;
            } else {
                tracing::warn!(project_id = project, "review_thread_catalog_reload_failed");
                publish_thread_delta(app, project, before.visible, queued);
                return Ok(());
            }
        }

        publish_thread_changes(app, project, &self.path, before, catalog).await;
        Ok(())
    }
}

async fn write_thread(
    app: &AppHandle,
    state: &AppState,
    project: &str,
    id: Uuid,
    edit: impl FnOnce(Option<&Record>) -> Result<Option<Value>, CommandError>,
) -> Result<(), CommandError> {
    let mut write = ThreadWrite::open(state, project, id).await?;
    if let Some(payload) = edit(write.catalog.record(project, &write.id))? {
        write.persist(app, payload).await?;
    }
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

    #[test]
    fn edits_only_live_thread_positions_and_notes() {
        let anchor = ReviewThreadInput {
            parent_chat_id: "parent".into(),
            path: "file.rs".into(),
            side: ReviewThreadSide::Right,
            home_kind: ReviewThreadHome::Worktree,
            tool_use_id: None,
            original_commit_id: "commit".into(),
            original_blob_id: "blob".into(),
            original_start_line: 1,
            original_line: 2,
            start_line: Some(1),
            line: Some(2),
            status: ReviewThreadStatus::Open,
            outdated_noted: false,
            origin_kind: ReviewThreadOrigin::Local,
            origin_ref: None,
        };
        let position = |start_line, line| ReviewThreadUpdate::Position {
            position: ReviewThreadPosition {
                status: ReviewThreadStatus::Open,
                start_line,
                line,
            },
        };
        let mut record = Record::default();
        record.remote.payload = anchor.clone().into_wire();
        assert!(
            edit_review_thread(Some(&record), position(Some(1), Some(2)))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            edit_review_thread(None, ReviewThreadUpdate::OutdatedNote)
                .unwrap_err()
                .message,
            "Review thread was not found."
        );
        assert_eq!(
            edit_review_thread(Some(&record), ReviewThreadUpdate::Anchor { anchor })
                .unwrap_err()
                .message,
            "The captured review anchor is immutable."
        );

        record.remote.payload = edit_review_thread(Some(&record), ReviewThreadUpdate::OutdatedNote)
            .unwrap()
            .unwrap();
        assert!(
            edit_review_thread(Some(&record), ReviewThreadUpdate::OutdatedNote)
                .unwrap()
                .is_none()
        );
        let moved = edit_review_thread(Some(&record), position(Some(4), Some(5)))
            .unwrap()
            .unwrap();
        assert_eq!(moved["start_line"], 4);
        assert_eq!(moved["line"], 5);
        assert_eq!(moved["original_start_line"], 1);
        assert_eq!(moved["outdated_noted"], true);

        let id = Uuid::new_v4();
        let mut catalog = Catalog::default();
        *catalog.upsert("project", &EntityKey::Thread(ThreadId(id))) = record.clone();
        assert!(thread_views(&catalog, "project")[&id]
            .checkout_path
            .is_none());
        catalog
            .anchor_checkouts
            .entry("project".into())
            .or_default()
            .insert(id, "/checkout".into());
        assert_eq!(
            thread_views(&catalog, "project")[&id]
                .checkout_path
                .as_deref(),
            Some("/checkout")
        );

        let before = thread_changes(&catalog, "project");
        assert_eq!(
            shared_thread_notification(&before, &catalog, "project", id),
            Some(before.visible.get(&id).cloned())
        );
        catalog
            .upsert("project", &EntityKey::Thread(ThreadId(id)))
            .remote
            .payload["deleted"] = json!(true);
        assert_eq!(
            shared_thread_notification(&before, &catalog, "project", id),
            None
        );
        let after = thread_changes(&catalog, "project");
        assert_eq!(
            shared_thread_notification(&after, &catalog, "project", id),
            Some(None)
        );

        record.remote.payload["deleted"] = json!(true);
        assert_eq!(
            edit_review_thread(Some(&record), ReviewThreadUpdate::OutdatedNote)
                .unwrap_err()
                .message,
            "Review thread has been deleted."
        );
        record.remote.payload = json!({});
        assert_eq!(
            edit_review_thread(Some(&record), ReviewThreadUpdate::OutdatedNote)
                .unwrap_err()
                .message,
            "The saved review thread is corrupt."
        );
    }

    #[test]
    fn cdc_deduplication_follows_the_cache_and_is_bounded_to_one_observer() {
        let key = ("/test-catalog".into(), "project".into(), Uuid::new_v4());
        let mut observed = RecentThreadRevisions::default();
        assert!(observed.apply(key.clone(), 2, Some(2), || Ok(())).unwrap());
        assert!(!observed
            .apply(key.clone(), 2, Some(2), || panic!(
                "duplicate must not merge"
            ))
            .unwrap());
        assert!(!observed
            .apply(key.clone(), 1, Some(2), || panic!(
                "stale event must not merge"
            ))
            .unwrap());
        assert!(observed.apply(key.clone(), 2, None, || Ok(())).unwrap());
        assert!(observed.apply(key.clone(), 2, Some(1), || Ok(())).unwrap());
        assert!(RecentThreadRevisions::default()
            .apply(key, 2, Some(2), || Ok(()))
            .unwrap());
        for revision in 0..RECENT_THREAD_REVISIONS as u64 {
            let key = ("/test-catalog".into(), "project".into(), Uuid::new_v4());
            assert!(observed.apply(key, revision, None, || Ok(())).unwrap());
        }
        assert_eq!(observed.0.len(), RECENT_THREAD_REVISIONS);
    }

    #[test]
    fn replayed_cdc_recreates_a_reset_catalog_in_the_same_observer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let id = Uuid::new_v4();
        let entity = EntityKey::Thread(ThreadId(id));
        let key = (path.clone(), "project".into(), id);
        let mut observed = RecentThreadRevisions::default();

        for (iteration, expected) in [true, false, true].into_iter().enumerate() {
            if iteration == 2 {
                fs::remove_file(&path).unwrap();
            }
            let mut catalog = load(&path).unwrap();
            let revision = catalog
                .record("project", &entity)
                .map(|record| record.remote.revision);
            let applied = observed
                .apply(key.clone(), 2, revision, || {
                    apply_entry(
                        &mut catalog,
                        &path,
                        "project",
                        Entry {
                            id: entity.clone(),
                            revision: 2,
                            payload: json!({"deleted": true}),
                        },
                    )?;
                    Ok(())
                })
                .unwrap();
            assert_eq!(applied, expected);
            assert_eq!(
                load(&path)
                    .unwrap()
                    .record("project", &entity)
                    .unwrap()
                    .remote
                    .revision,
                2
            );
        }
    }

    #[tokio::test]
    async fn only_an_acknowledged_tombstone_releases_an_anchor() {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(directory.path()).unwrap();
        let project_directory = tempfile::tempdir().unwrap();
        let other_repo = git2::Repository::init(project_directory.path()).unwrap();
        let id = Uuid::new_v4();
        let name = format!("refs/vertebrae/threads/{id}");
        let blob = repo.blob(b"selected\n").unwrap();
        repo.reference(&name, blob, false, "fixture anchor")
            .unwrap();

        other_repo
            .reference(
                &name,
                other_repo.blob(b"other repository").unwrap(),
                false,
                "fixture",
            )
            .unwrap();
        let mut catalog = Catalog::default();
        let key = EntityKey::Thread(ThreadId(id));
        catalog
            .anchor_repositories
            .entry("project".into())
            .or_default()
            .insert(id, repo.commondir().to_path_buf());
        catalog
            .anchor_checkouts
            .entry("project".into())
            .or_default()
            .insert(id, "/linked-checkout".into());
        let catalog_path = project_directory.path().join("catalog.json");
        catalog.upsert("project", &key).desired = Some(json!({"deleted": true}));
        recover_anchor_cleanup(&mut catalog, "project", &catalog_path).await;
        assert_eq!(repo.refname_to_id(&name).unwrap(), blob);

        let mut catalog = storage::decode(&storage::encode(&catalog).unwrap()).unwrap();
        assert_eq!(catalog.anchor_checkouts["project"][&id], "/linked-checkout");
        catalog.upsert("project", &key).remote.payload = json!({"deleted": true});
        recover_anchor_cleanup(&mut catalog, "project", &catalog_path).await;
        assert!(repo.find_reference(&name).is_err());
        assert!(other_repo.find_reference(&name).is_ok());
        let saved = load(&catalog_path).unwrap();
        assert!(saved.anchor_repositories.is_empty());
        assert!(saved.anchor_checkouts.is_empty());
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
