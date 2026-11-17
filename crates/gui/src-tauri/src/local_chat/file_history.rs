//! Durable, base-relative turn captures. Reconstruction touches only a private
//! in-memory object database, never the live index or working directory.
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::annotations::{AnnotationSubject, PublishOutcome};
use super::worktree_delta::recorder::RecorderGate;
use super::worktree_delta::{git, patch};
use super::worktree_files::{self, FileBody};
use super::{LocalChatAnnotation, LocalChatAnnotationStore};

pub(crate) const HISTORY_KIND: &str = "worktree_history";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum CaptureState {
    Ready {
        patch: String,
        files: Vec<patch::FileEntry>,
        #[serde(default)]
        unsafe_clean_paths: Option<BTreeSet<String>>,
    },
    Unavailable {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Capture {
    version: u32,
    epoch: String,
    repository: PathBuf,
    worktree: PathBuf,
    base_head: Option<String>,
    #[serde(default = "default_side_bytes")]
    side_bytes: u64,
    #[serde(flatten)]
    state: CaptureState,
}

#[derive(Clone)]
pub(crate) struct HistoryRecorder {
    session: String,
    capture: Capture,
    limits: git::Limits,
    baseline_ready: bool,
    attempted_turns: Arc<Mutex<HashSet<String>>>,
}

impl HistoryRecorder {
    #[cfg(test)]
    pub(crate) fn start(
        session: &str,
        worktree: &Path,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
        limits: &git::Limits,
    ) -> Self {
        Self::start_active(session, worktree, store, snapshot, limits, None)
    }

    pub(crate) fn start_active(
        session: &str,
        worktree: &Path,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
        limits: &git::Limits,
        gate: Option<&RecorderGate>,
    ) -> Self {
        Self::start_with_hook(session, worktree, store, snapshot, limits, gate, || {})
    }

    fn start_with_hook(
        session: &str,
        worktree: &Path,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
        limits: &git::Limits,
        gate: Option<&RecorderGate>,
        after_anchor: impl FnOnce(),
    ) -> Self {
        if let Err(error) = store.load(session) {
            log::warn!("[CHAT_HISTORY] metadata load failed: {error}");
        }
        let epoch = uuid::Uuid::new_v4().to_string();
        let mut capture = Capture {
            version: VERSION,
            epoch: epoch.clone(),
            repository: PathBuf::new(),
            worktree: worktree.to_owned(),
            base_head: snapshot.and_then(|s| s.head.clone()),
            side_bytes: limits.side_bytes,
            state: CaptureState::Unavailable {
                message: "Initial state could not be captured".into(),
            },
        };
        let anchored = git::repository(worktree).and_then(|repo| {
            capture.repository = repo
                .commondir()
                .canonicalize()
                .map_err(|error| git::GitError::Failed(error.to_string()))?;
            if let Some(head) = &capture.base_head {
                let mut owner=LocalChatAnnotation::new(session,"","worktree_retention",serde_json::json!({"epoch":epoch,"repository":capture.repository,"base_head":head}));
                owner.subject=Some(AnnotationSubject::Association(epoch.clone()));
                let ownership=store.publish_record(owner,None,||gate.is_none_or(RecorderGate::is_active)).map_err(|e|git::GitError::Failed(e.to_string()))?;
                if !matches!(ownership,PublishOutcome::Written|PublishOutcome::Existing) {return Err(git::GitError::Failed("Conversation history is no longer active".into()));}
                let id=head.parse()?;
                let retained=store.while_session_live(session,||repo.reference(&format!("refs/vertebrae/chat-history/{epoch}"),id,false,"retain conversation history baseline"))
                    .map_err(|e|git::GitError::Failed(e.to_string()))?;
                match retained {Some(result)=>{result?;},None=>return Err(git::GitError::Failed("Conversation was deleted before retention".into()))}

            }
            Ok(())
        });
        if let Err(error) = &anchored {
            capture.state = CaptureState::Unavailable {
                message: error.to_string(),
            };
        }
        after_anchor();
        let mut recorder = Self {
            session: session.into(),
            capture,
            limits: *limits,
            baseline_ready: anchored.is_ok() && snapshot.is_some(),
            attempted_turns: Arc::new(Mutex::new(HashSet::new())),
        };
        let state = if anchored.is_ok() {
            recorder.state(snapshot)
        } else {
            recorder.capture.state.clone()
        };
        let saved = recorder.append(store, AnnotationSubject::Association(epoch), state, || {
            gate.is_none_or(RecorderGate::is_active)
        });
        if !saved {
            let mut annotation = LocalChatAnnotation::new(
                session,
                "",
                HISTORY_KIND,
                serde_json::to_value(&recorder.capture).unwrap_or_default(),
            );
            annotation.subject = Some(AnnotationSubject::Association(
                recorder.capture.epoch.clone(),
            ));
            release_baselines(&[annotation]);
            recorder.baseline_ready = false;
        }
        recorder
    }

    fn state(&self, snapshot: Option<&git::Snapshot>) -> CaptureState {
        let Some(snapshot) = snapshot else {
            return CaptureState::Unavailable {
                message: "The turn's worktree state could not be captured".into(),
            };
        };
        if !self.baseline_ready {
            return self.capture.state.clone();
        }
        // An empty dirty set means the immutable base commit, not the dirty
        // association state. Every capture includes all base-relative changes.
        let base = git::Snapshot {
            head: self.capture.base_head.clone(),
            branch: snapshot.branch.clone(),
            dirty: BTreeSet::new(),
            files: BTreeMap::new(),
        };
        match patch::compute(&self.capture.worktree, &base, snapshot, &self.limits) {
            Ok(delta) => match unsafe_clean_paths(&self.capture.worktree) {
                Ok(unsafe_paths) => {
                    if !git::snapshot(&self.capture.worktree, &self.limits, &snapshot.branch)
                        .is_ok_and(|end| end.agrees_with(snapshot))
                    {
                        return CaptureState::Unavailable {
                            message: "The worktree changed while its capture was prepared".into(),
                        };
                    }
                    CaptureState::Ready {
                        patch: delta.patch,
                        files: delta.files,
                        unsafe_clean_paths: Some(unsafe_paths),
                    }
                }
                Err(error) => CaptureState::Unavailable {
                    message: error.to_string(),
                },
            },
            Err(error) => CaptureState::Unavailable {
                message: error.to_string(),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn capture(
        &self,
        turn: &str,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
    ) {
        self.record_origin(turn, store);
        self.capture_checked(turn, store, snapshot, || true);
    }

    pub(crate) fn contains_turn(&self, turn: &str, store: &LocalChatAnnotationStore) -> bool {
        if self
            .attempted_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(turn)
        {
            return true;
        }
        store
            .record_exists(
                &self.session,
                HISTORY_KIND,
                &AnnotationSubject::Turn(turn.into()),
            )
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn record_origin(&self, turn: &str, store: &LocalChatAnnotationStore) {
        self.record_origin_checked(turn, store, || true);
    }

    pub(crate) fn record_origin_checked(
        &self,
        turn: &str,
        store: &LocalChatAnnotationStore,
        valid: impl Fn() -> bool,
    ) {
        let mut entry = LocalChatAnnotation::new(
            &self.session,
            "",
            "worktree_origin",
            serde_json::json!({"worktree":self.capture.worktree,"epoch":self.capture.epoch}),
        );
        entry.subject = Some(AnnotationSubject::Turn(turn.into()));
        if let Err(error) = store.publish_record(entry, None, valid) {
            log::warn!("[CHAT_HISTORY] origin write failed: {error}");
        }
    }

    pub(crate) fn capture_checked(
        &self,
        turn: &str,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
        valid: impl Fn() -> bool,
    ) {
        self.capture_with_hook(turn, store, snapshot, valid, || {});
    }

    fn capture_with_hook(
        &self,
        turn: &str,
        store: &LocalChatAnnotationStore,
        snapshot: Option<&git::Snapshot>,
        valid: impl Fn() -> bool,
        after_prepare: impl FnOnce(),
    ) {
        if self.contains_turn(turn, store) {
            return;
        }
        if !self
            .attempted_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(turn.into())
        {
            return;
        }
        let origin = store.read_record(
            &self.session,
            "worktree_origin",
            &AnnotationSubject::Turn(turn.into()),
        );
        let matches_origin = origin
            .as_ref()
            .ok()
            .and_then(|v| v.as_ref())
            .and_then(|v| v.get("worktree"))
            .and_then(|v| v.as_str())
            == self.capture.worktree.to_str()
            && origin
                .as_ref()
                .ok()
                .and_then(|v| v.as_ref())
                .and_then(|v| v.get("epoch"))
                .and_then(|v| v.as_str())
                == Some(self.capture.epoch.as_str());
        let state = if matches_origin {
            self.state(snapshot)
        } else {
            CaptureState::Unavailable {
                message: "The conversation changed checkout before this turn was captured".into(),
            }
        };
        after_prepare();
        let mut capture = Capture {
            state,
            ..self.capture.clone()
        };
        if !matches_origin {
            capture.worktree = PathBuf::new();
            capture.repository = PathBuf::new();
            capture.base_head = None;
        }
        if let Ok(Some(origin)) = origin {
            if let Some(root) = origin.get("worktree").and_then(|v| v.as_str()) {
                capture.worktree = root.into();
            }
            if let Some(epoch) = origin.get("epoch").and_then(|v| v.as_str()) {
                capture.epoch = epoch.into();
            }
        }
        let subject = AnnotationSubject::Turn(turn.into());
        let make = |capture: &Capture| -> Result<LocalChatAnnotation, serde_json::Error> {
            let mut entry = LocalChatAnnotation::new(
                &self.session,
                "",
                HISTORY_KIND,
                serde_json::to_value(capture)?,
            );
            entry.subject = Some(subject.clone());
            Ok(entry)
        };
        let expired = Capture {
            state: CaptureState::Unavailable {
                message: "Turn capture expired or was superseded before publication".into(),
            },
            ..capture.clone()
        };
        let result =
            make(&capture).and_then(|entry| make(&expired).map(|expired| (entry, expired)));
        match result {
            Ok((entry, expired)) => {
                if let Err(error) = store.publish_record(entry, Some(expired), valid) {
                    log::warn!("[CHAT_HISTORY] capture failed: {error}");
                }
            }
            Err(error) => log::warn!("[CHAT_HISTORY] capture encoding failed: {error}"),
        }
    }

    fn append(
        &self,
        store: &LocalChatAnnotationStore,
        subject: AnnotationSubject,
        state: CaptureState,
        valid: impl Fn() -> bool,
    ) -> bool {
        let capture = Capture {
            state,
            ..self.capture.clone()
        };
        let result = serde_json::to_value(capture)
            .map_err(|error| error.to_string())
            .and_then(|payload| {
                let mut annotation =
                    LocalChatAnnotation::new(&self.session, "", HISTORY_KIND, payload);
                annotation.subject = Some(subject);
                store
                    .publish_record(annotation, None, valid)
                    .map(|outcome| {
                        matches!(outcome, PublishOutcome::Written | PublishOutcome::Existing)
                    })
                    .map_err(|error| error.to_string())
            });
        match result {
            Ok(saved) => saved,
            Err(error) => {
                log::warn!("[CHAT_HISTORY] could not persist capture: {error}");
                false
            }
        }
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum HistoryFailureKind {
    NotCaptured,
    CaptureUnavailable,
    Unsupported,
    InvalidPath,
    Storage,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct HistoryFailure {
    pub kind: HistoryFailureKind,
    pub message: String,
    pub retryable: bool,
}
impl HistoryFailure {
    fn new(kind: HistoryFailureKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }
    fn storage(error: impl std::fmt::Display) -> Self {
        Self::new(HistoryFailureKind::Storage, error.to_string(), true)
    }
}
impl std::fmt::Display for HistoryFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for HistoryFailure {}
impl From<git2::Error> for HistoryFailure {
    fn from(error: git2::Error) -> Self {
        Self::storage(error)
    }
}
impl From<String> for HistoryFailure {
    fn from(message: String) -> Self {
        Self::new(HistoryFailureKind::Unsupported, message, false)
    }
}
impl From<&str> for HistoryFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(untagged)]
pub enum HistoryRead {
    File(FileBody),
    Failure { error: HistoryFailure },
}

pub(crate) fn read_for_view(
    store: &LocalChatAnnotationStore,
    session: &str,
    turn: &str,
    path: &str,
) -> HistoryRead {
    match read_file(store, session, turn, path) {
        Ok(body) => HistoryRead::File(body),
        Err(error) => HistoryRead::Failure { error },
    }
}

#[cfg(test)]
pub(crate) fn read(
    store: &LocalChatAnnotationStore,
    session: &str,
    turn: &str,
    path: &str,
) -> Result<FileBody, String> {
    read_file(store, session, turn, path).map_err(|e| e.to_string())
}

fn read_file(
    store: &LocalChatAnnotationStore,
    session: &str,
    turn: &str,
    path: &str,
) -> Result<FileBody, HistoryFailure> {
    let path = worktree_files::relative(path)
        .map_err(|e| HistoryFailure::new(HistoryFailureKind::InvalidPath, e.to_string(), false))?;
    let subject = AnnotationSubject::Turn(turn.into());
    let payload = store
        .read_record(session, HISTORY_KIND, &subject)
        .map_err(HistoryFailure::storage)?
        .ok_or_else(|| {
            HistoryFailure::new(
                HistoryFailureKind::NotCaptured,
                "No historical capture is available for this turn",
                true,
            )
        })?;
    let capture: Capture = serde_json::from_value(payload)
        .map_err(|e| HistoryFailure::new(HistoryFailureKind::Unsupported, e.to_string(), false))?;
    if let CaptureState::Unavailable { message } = &capture.state {
        return Err(HistoryFailure::new(
            HistoryFailureKind::CaptureUnavailable,
            message,
            false,
        ));
    }
    reconstruct(&capture, &path)
}

fn reconstruct(capture: &Capture, path: &str) -> Result<FileBody, HistoryFailure> {
    if capture.version != VERSION {
        return Err("Unsupported history format".into());
    }
    let (patch, files, unsafe_clean_paths) = match &capture.state {
        CaptureState::Ready {
            patch,
            files,
            unsafe_clean_paths,
        } => (patch, files, unsafe_clean_paths),
        CaptureState::Unavailable { message } => return Err(message.clone().into()),
    };
    let file = files
        .iter()
        .find(|file| file.path == path || file.old_path.as_deref() == Some(path));
    if let Some(marker) = file.and_then(|file| file.marker.as_ref()) {
        let message = match marker.reason {
            git::MarkerReason::Binary => "Binary contents were not retained for this turn.",
            git::MarkerReason::TooLarge => "This file exceeded the historical capture size limit.",
            git::MarkerReason::BaselineUnavailable => {
                "The file's starting contents were not captured."
            }
            git::MarkerReason::PatchLimit => "This file exceeded the turn's patch budget.",
            git::MarkerReason::Unreadable => {
                "This file could not be read when the turn was captured."
            }
        };
        return Err(message.into());
    }
    let repo = git2::Repository::open(&capture.repository)?;
    let base = capture
        .base_head
        .as_ref()
        .map(|id| repo.find_commit(id.parse()?))
        .transpose()?;
    let tree = base.map(|commit| commit.tree()).transpose()?;
    if file.is_none() {
        if unsafe_clean_paths
            .as_ref()
            .is_none_or(|paths| paths.contains(path))
        {
            return Ok(FileBody::Unreadable {
                message: "Working-directory transformations were not captured for this file".into(),
            });
        }
        return read_tree(&repo, tree.as_ref(), path, capture.side_bytes);
    }
    // A rename's old path is absent in this state. Never silently follow it.
    if file.is_some_and(|file| file.path != path) {
        return Ok(FileBody::Missing);
    }
    let diff = git2::Diff::from_buffer(patch.as_bytes())?;
    let index = diff
        .deltas()
        .position(|delta| delta.new_file().path() == Some(Path::new(path)))
        .ok_or("Recorded file has no reconstructable patch")?;
    let mut selected =
        git2::Patch::from_diff(&diff, index)?.ok_or("Recorded patch is unavailable")?;
    let bytes = selected.to_buf()?;
    let selected = git2::Diff::from_buffer(&bytes)?;
    let memory = patch::memory_repository().map_err(|error| error.to_string())?;
    let mut baseline = git2::Index::new()?;
    let old_path = file
        .and_then(|file| file.old_path.as_deref())
        .unwrap_or(path);
    if let Some(entry) = tree
        .as_ref()
        .and_then(|tree| tree.get_path(Path::new(old_path)).ok())
    {
        let blob = repo.find_blob(entry.id())?;
        if blob.size() as u64 > capture.side_bytes {
            return Ok(FileBody::TooLarge);
        }
        baseline.add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: entry.filemode() as u32,
            uid: 0,
            gid: 0,
            file_size: blob.size() as u32,
            id: memory.blob(blob.content())?,
            flags: 0,
            flags_extended: 0,
            path: old_path.as_bytes().to_vec(),
        })?;
    }
    let baseline = memory.find_tree(baseline.write_tree_to(&memory)?)?;
    let applied = memory.apply_to_tree(&baseline, &selected, None)?;
    let Some(entry) = applied.get_path(Path::new(path), 0) else {
        return Ok(FileBody::Missing);
    };
    let blob = memory.find_blob(entry.id)?;
    Ok(worktree_files::classify(blob.content().to_vec()))
}

fn read_tree(
    repo: &git2::Repository,
    tree: Option<&git2::Tree<'_>>,
    path: &str,
    side_bytes: u64,
) -> Result<FileBody, HistoryFailure> {
    let entry = match tree.map(|tree| tree.get_path(Path::new(path))) {
        None => return Ok(FileBody::Missing),
        Some(Err(error)) if error.code() == git2::ErrorCode::NotFound => {
            return Ok(FileBody::Missing)
        }
        Some(result) => result?,
    };
    let (size, _) = repo.odb()?.read_header(entry.id())?;
    if size as u64 > side_bytes {
        return Ok(FileBody::TooLarge);
    }
    if entry.kind() != Some(git2::ObjectType::Blob) {
        return Err("Historical path is not a file".into());
    }
    Ok(worktree_files::classify(
        repo.find_blob(entry.id())?.content().to_vec(),
    ))
}

/// Baseline refs have the same lifetime as their conversation annotations.
/// Only this feature's UUID-named refs, still pointing at the recorded commit,
/// are released. Ordinary branches, tags, the index and files are untouched.
pub(crate) fn release_baselines(entries: &[LocalChatAnnotation]) {
    for entry in entries {
        if !matches!(entry.kind.as_str(), HISTORY_KIND | "worktree_retention")
            || !matches!(entry.subject, Some(AnnotationSubject::Association(_)))
        {
            continue;
        }
        #[derive(Deserialize)]
        struct Retention {
            epoch: String,
            repository: PathBuf,
            base_head: Option<String>,
        }
        let Ok(capture) = serde_json::from_value::<Retention>(entry.payload.clone()) else {
            continue;
        };
        if uuid::Uuid::parse_str(&capture.epoch).is_err() {
            continue;
        }
        let Ok(repo) = git2::Repository::open(&capture.repository) else {
            continue;
        };
        let Ok(mut reference) =
            repo.find_reference(&format!("refs/vertebrae/chat-history/{}", capture.epoch))
        else {
            continue;
        };
        if reference.target().map(|id| id.to_string()) == capture.base_head {
            if let Err(error) = reference.delete() {
                log::warn!("[CHAT_HISTORY] could not release baseline: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests;

fn default_side_bytes() -> u64 {
    git::Limits::default().side_bytes
}

/// Conservative per-path proof: filtered/normalized clean blobs are not
/// claimed to be the bytes observed on disk. Dirty sides are already captured.
fn unsafe_clean_paths(worktree: &Path) -> Result<BTreeSet<String>, git::GitError> {
    let repo = git::repository(worktree)?;
    let config = repo.config()?;
    let auto = match config.get_string("core.autocrlf") {
        Ok(value) => value,
        Err(error) if error.code() == git2::ErrorCode::NotFound => "false".into(),
        Err(error) => return Err(error.into()),
    };
    let globally_normalized = auto != "false" && auto != "0";
    let index = repo.index()?;
    if index.len() > 100_000 {
        return Err(git::GitError::TooManyEntries(index.len()));
    }
    let mut excluded = BTreeSet::new();
    for entry in index.iter() {
        let path = git::utf8_path(&entry.path)?;
        let mut transformed = globally_normalized || entry.mode == 0o120000;
        for attr in ["text", "eol", "filter", "working-tree-encoding", "ident"] {
            if !matches!(
                git2::AttrValue::from_string(repo.get_attr(
                    Path::new(&path),
                    attr,
                    git2::AttrCheckFlags::FILE_THEN_INDEX
                )?),
                git2::AttrValue::Unspecified | git2::AttrValue::False
            ) {
                transformed = true;
            }
        }
        if transformed {
            excluded.insert(path);
        }
    }
    Ok(excluded)
}
