//! Local Git storage and line mapping for review threads.

use git2::{ErrorCode, Oid, Repository};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    local_chat::{
        annotations::LocalChatAnnotationStore,
        file_history::{self, HistoryRead},
        worktree_files,
    },
    review_anchors::{self as anchors, AnchorError},
};

pub use crate::review_anchors::ReviewLineRange;

use super::review_threads::{
    ReviewThreadHome, ReviewThreadInput, ReviewThreadOrigin, ReviewThreadSide, ReviewThreadStatus,
    ThreadWrite,
};
use super::AppState;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAnchorError {
    NotRepository,
    UnbornHead,
    InvalidPath,
    InvalidRange,
    ContentUnavailable,
    CatalogUnavailable,
    ParentUnavailable,
    Git,
}

impl From<git2::Error> for ReviewAnchorError {
    fn from(error: git2::Error) -> Self {
        tracing::warn!(code = ?error.code(), class = ?error.class(), "review_anchor_git_failed");
        Self::Git
    }
}

/// Core reads keep their own detail; the wire keeps its coarse kinds.
impl From<AnchorError> for ReviewAnchorError {
    fn from(error: AnchorError) -> Self {
        match error {
            AnchorError::NotRepository => Self::NotRepository,
            AnchorError::UnbornHead => Self::UnbornHead,
            AnchorError::InvalidPath => Self::InvalidPath,
            AnchorError::InvalidRange => Self::InvalidRange,
            AnchorError::Unreadable => Self::ContentUnavailable,
            AnchorError::MissingCommit | AnchorError::Git => Self::Git,
        }
    }
}

#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewAnchorSource {
    Worktree {
        commit: Option<String>,
    },
    FullFile {
        turn: Option<ReviewAnchorTurn>,
    },
    ToolCall {
        #[serde(rename = "chatId")]
        chat_id: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
    },
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorTurn {
    session_id: String,
    turn_id: String,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorLocation {
    path: String,
    side: ReviewThreadSide,
    source: ReviewAnchorSource,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CapturedReviewAnchor {
    original_commit_id: String,
    original_blob_id: String,
    /// The captured lines, as the retained blob has them.
    code: String,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorParent {
    chat_id: String,
    project_path: Option<String>,
}

/// What a discussion is about: code the user selected (checked against what
/// is captured), or the lines a GitHub review thread is on, whose anchor
/// GitHub owns, so the captured lines are read here rather than sent.
#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewAnchorSubject {
    Selection {
        #[serde(rename = "selectedText")]
        selected_text: String,
    },
    GithubThread {
        #[serde(rename = "githubThreadId")]
        github_thread_id: String,
    },
}

/// Prefix of the catalog `origin_ref` that links a discussion to the GitHub
/// review thread it discusses.
pub(super) const GITHUB_THREAD_ORIGIN: &str = "github-thread:";

/// A GitHub thread link holds a GitHub node ID, checked as the adapter
/// checks the threads it writes to.
pub(super) use vertebrae_github::is_valid_node_id as valid_github_thread_id;

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorRequest {
    worktree: String,
    thread_id: Uuid,
    location: ReviewAnchorLocation,
    range: ReviewLineRange,
    subject: ReviewAnchorSubject,
    parent: Option<ReviewAnchorParent>,
}

/// The catalog home of a new thread: its kind, tool call and origin
/// reference. A GitHub thread is anchored only on worktree content.
fn catalog_home(
    source: &ReviewAnchorSource,
    subject: &ReviewAnchorSubject,
) -> Result<(ReviewThreadHome, Option<String>, Option<String>), ReviewAnchorError> {
    if let ReviewAnchorSubject::GithubThread { github_thread_id } = subject {
        return match source {
            ReviewAnchorSource::Worktree { .. } if valid_github_thread_id(github_thread_id) => {
                Ok((
                    ReviewThreadHome::Worktree,
                    None,
                    Some(format!("{GITHUB_THREAD_ORIGIN}{github_thread_id}")),
                ))
            }
            _ => Err(ReviewAnchorError::ContentUnavailable),
        };
    }
    Ok(match source {
        ReviewAnchorSource::ToolCall { tool_use_id, .. } => {
            (ReviewThreadHome::ToolCall, Some(tool_use_id.clone()), None)
        }
        ReviewAnchorSource::Worktree { .. } => (ReviewThreadHome::Worktree, None, None),
        // The catalog's worktree home supports local origin references. Keep
        // the full-file identity alongside its retained blob and checkout.
        ReviewAnchorSource::FullFile { turn } => {
            let identity = match turn {
                Some(turn) => serde_json::json!([turn.session_id, turn.turn_id]).to_string(),
                None => "null".into(),
            };
            (
                ReviewThreadHome::Worktree,
                None,
                Some(format!("full-file:{identity}")),
            )
        }
    })
}

/// Whether the captured lines are what the discussion is about.
fn subject_matches(snippet: &str, subject: &ReviewAnchorSubject) -> bool {
    match subject {
        ReviewAnchorSubject::Selection { selected_text } => {
            selected_text_matches(snippet, selected_text)
        }
        ReviewAnchorSubject::GithubThread { .. } => true,
    }
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMappingRequest {
    thread_id: Uuid,
    original_blob_id: String,
    range: ReviewLineRange,
    location: ReviewAnchorLocation,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMappingStatus {
    Open,
    Outdated,
    Unavailable,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MappedReviewThread {
    thread_id: Uuid,
    start_line: Option<u32>,
    line: Option<u32>,
    status: ReviewMappingStatus,
}

/// Where a selection's lines are in another version of the file.
#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MappedReviewRange {
    start_line: Option<u32>,
    line: Option<u32>,
    status: ReviewMappingStatus,
}

fn repository(folder: &str) -> Result<Repository, ReviewAnchorError> {
    let repo = Repository::discover(folder).map_err(|_| ReviewAnchorError::NotRepository)?;
    if repo.is_bare() {
        return Err(ReviewAnchorError::NotRepository);
    }
    Ok(repo)
}

fn open(worktree: &str) -> Result<(Repository, Oid), ReviewAnchorError> {
    let repo = repository(worktree)?;
    let head = anchors::open_head(&repo)?;
    Ok((repo, head))
}

fn ref_name(thread: Uuid) -> String {
    format!("refs/vertebrae/threads/{thread}")
}

pub(super) fn release(repo: &Repository, thread: Uuid) -> Result<(), git2::Error> {
    match repo.find_reference(&ref_name(thread)) {
        Ok(mut reference) => reference.delete(),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn content(
    repo: &Repository,
    head: Oid,
    location: &ReviewAnchorLocation,
    annotations: &LocalChatAnnotationStore,
) -> Result<Option<Vec<u8>>, ReviewAnchorError> {
    if let ReviewAnchorSource::FullFile { turn: Some(turn) } = &location.source {
        let checkout = repo.workdir().ok_or(ReviewAnchorError::NotRepository)?;
        return match file_history::read_for_checkout(
            annotations,
            &turn.session_id,
            &turn.turn_id,
            &location.path,
            Some(checkout),
        ) {
            HistoryRead::File(worktree_files::FileBody::Text { contents, .. }) => {
                Ok(Some(contents.into_bytes()))
            }
            _ => Err(ReviewAnchorError::ContentUnavailable),
        };
    }
    let ReviewAnchorSource::ToolCall {
        chat_id,
        tool_use_id,
    } = &location.source
    else {
        return worktree_content(repo, head, location);
    };
    if location.side == ReviewThreadSide::Left {
        return Err(ReviewAnchorError::ContentUnavailable);
    }
    let relative =
        worktree_files::relative(&location.path).map_err(|_| ReviewAnchorError::InvalidPath)?;
    let entries = annotations
        .load(chat_id)
        .map_err(|_| ReviewAnchorError::ContentUnavailable)?;
    Ok(entries
        .iter()
        .rev()
        .find(|entry| entry.kind == "worktree_delta" && &entry.tool_id == tool_use_id)
        .and_then(|entry| entry.payload["review_post_images"][&relative].as_str())
        .map(|text| text.as_bytes().to_vec()))
}

fn worktree_content(
    repo: &Repository,
    head: Oid,
    location: &ReviewAnchorLocation,
) -> Result<Option<Vec<u8>>, ReviewAnchorError> {
    if matches!(location.source, ReviewAnchorSource::FullFile { turn: None }) {
        let root = repo.workdir().ok_or(ReviewAnchorError::NotRepository)?;
        return match worktree_files::read_file(root, &location.path)
            .map_err(|_| ReviewAnchorError::ContentUnavailable)?
        {
            worktree_files::FileBody::Text { contents, .. } => Ok(Some(contents.into_bytes())),
            worktree_files::FileBody::Missing => Ok(None),
            _ => Err(ReviewAnchorError::ContentUnavailable),
        };
    }
    let relative =
        worktree_files::relative(&location.path).map_err(|_| ReviewAnchorError::InvalidPath)?;
    match &location.source {
        ReviewAnchorSource::ToolCall { .. } | ReviewAnchorSource::FullFile { .. } => {
            Err(ReviewAnchorError::ContentUnavailable)
        }
        ReviewAnchorSource::Worktree { commit: None }
            if location.side == ReviewThreadSide::Right =>
        {
            Ok(anchors::working_file(repo, &relative)?)
        }
        ReviewAnchorSource::Worktree { commit } => {
            let commit = commit
                .as_deref()
                .map(Oid::from_str)
                .transpose()?
                .unwrap_or(head);
            Ok(anchors::commit_file(repo, commit, &relative)?)
        }
    }
}

fn capture(repo: &Repository, thread: Uuid, bytes: &[u8]) -> Result<Oid, ReviewAnchorError> {
    let blob = repo.blob(bytes)?;
    repo.reference(
        &ref_name(thread),
        blob,
        false,
        "retain review thread anchor",
    )?;
    Ok(blob)
}

fn selected_text_matches(actual: &str, selected: &str) -> bool {
    let snippet = actual.strip_suffix('\n').unwrap_or(actual);
    // The renderer may normalize CRLF, but the Git blob preserves exact bytes.
    let normalized = actual.replace("\r\n", "\n");
    snippet == selected || normalized.strip_suffix('\n').unwrap_or(&normalized) == selected
}

async fn git_job<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ReviewAnchorError> + Send + 'static,
) -> Result<T, ReviewAnchorError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "review_anchor_worker_failed");
            ReviewAnchorError::Git
        })?
}

#[tauri::command]
#[specta::specta]
pub async fn check_review_anchor_worktree(worktree: String) -> Result<(), ReviewAnchorError> {
    git_job(move || open(&worktree).map(|_| ())).await
}

#[tauri::command]
#[specta::specta]
pub async fn capture_review_anchor(
    app: AppHandle,
    state: State<'_, AppState>,
    annotations: State<'_, LocalChatAnnotationStore>,
    request: ReviewAnchorRequest,
) -> Result<CapturedReviewAnchor, ReviewAnchorError> {
    let ReviewAnchorRequest {
        worktree,
        thread_id,
        location,
        range,
        subject,
        parent,
    } = request;
    let parent = parent.ok_or(ReviewAnchorError::ParentUnavailable)?;
    let (home_kind, tool_use_id, origin_ref) = catalog_home(&location.source, &subject)?;
    if let ReviewAnchorSource::FullFile { turn } = &location.source {
        if location.side != ReviewThreadSide::Right
            || turn
                .as_ref()
                .is_some_and(|turn| turn.session_id != parent.chat_id)
        {
            return Err(ReviewAnchorError::ContentUnavailable);
        }
    }
    let project_path = parent
        .project_path
        .ok_or(ReviewAnchorError::ParentUnavailable)?;
    let project = super::project_id_for_path(&state, &project_path)
        .map_err(|_| ReviewAnchorError::ParentUnavailable)?;
    let annotations = annotations.inner().clone();
    let checkout = worktree.clone();
    // Stage the ref before acquiring the catalog lock. A process crash before
    // the catalog save can leave it untracked; recovery only releases refs
    // whose ownership was saved in the catalog.
    let (anchor, location, common_dir) = git_job(move || {
        let (repo, head) = open(&checkout)?;
        let common_dir = repo.commondir().canonicalize().map_err(|error| {
            tracing::warn!(kind = ?error.kind(), "review_anchor_repository_path_failed");
            ReviewAnchorError::Git
        })?;
        let bytes = content(&repo, head, &location, &annotations)?
            .ok_or(ReviewAnchorError::ContentUnavailable)?;
        let snippet = std::str::from_utf8(range.slice(&bytes)?)
            .map_err(|_| ReviewAnchorError::ContentUnavailable)?;
        if !subject_matches(snippet, &subject) {
            return Err(ReviewAnchorError::ContentUnavailable);
        }
        let blob = capture(&repo, thread_id, &bytes)?;
        Ok((
            CapturedReviewAnchor {
                original_commit_id: head.to_string(),
                original_blob_id: blob.to_string(),
                code: snippet.to_owned(),
            },
            location,
            common_dir,
        ))
    })
    .await?;

    let payload = ReviewThreadInput {
        parent_chat_id: parent.chat_id,
        path: location.path,
        side: location.side,
        home_kind,
        tool_use_id,
        original_commit_id: anchor.original_commit_id.clone(),
        original_blob_id: anchor.original_blob_id.clone(),
        original_start_line: range.start_line,
        original_line: range.line,
        start_line: Some(range.start_line),
        line: Some(range.line),
        status: ReviewThreadStatus::Open,
        outdated_noted: false,
        origin_kind: ReviewThreadOrigin::Local,
        origin_ref,
    };
    let mut write = match ThreadWrite::open(&state, &project, thread_id).await {
        Ok(write) => write,
        Err(_) => {
            rollback_ref(common_dir, thread_id).await;
            return Err(ReviewAnchorError::CatalogUnavailable);
        }
    };
    if !write.can_create(&payload.parent_chat_id) {
        drop(write);
        rollback_ref(common_dir, thread_id).await;
        return Err(ReviewAnchorError::ParentUnavailable);
    }
    write.retain_in(common_dir.clone(), worktree);
    if write.persist(&app, payload.into_wire()).await.is_err() {
        let unregistered = write.registration_absent();
        drop(write);
        if unregistered {
            rollback_ref(common_dir, thread_id).await;
        }
        return Err(ReviewAnchorError::CatalogUnavailable);
    }
    Ok(anchor)
}

async fn rollback_ref(common_dir: std::path::PathBuf, thread_id: Uuid) {
    if git_job(move || release(&Repository::open(common_dir)?, thread_id).map_err(Into::into))
        .await
        .is_err()
    {
        tracing::warn!(%thread_id, "review_anchor_rollback_failed");
    }
}

#[tauri::command]
#[specta::specta]
pub async fn map_review_threads(
    worktree: String,
    threads: Vec<ReviewMappingRequest>,
) -> Result<Vec<MappedReviewThread>, ReviewAnchorError> {
    git_job(move || {
        let (repo, head) = open(&worktree)?;
        Ok(threads
            .into_iter()
            .map(|thread| map_thread(&repo, head, thread))
            .collect())
    })
    .await
}

/// Where `range` of `original` is in `onto`'s content, unchanged: outdated
/// when it changed or `onto` has no such file.
fn map_onto(
    repo: &Repository,
    head: Oid,
    original: &[u8],
    range: ReviewLineRange,
    onto: &ReviewAnchorLocation,
) -> Result<Option<ReviewLineRange>, ReviewAnchorError> {
    let Some(current) = worktree_content(repo, head, onto)? else {
        return Ok(None);
    };
    if std::str::from_utf8(&current).is_err() || current.contains(&0) {
        return Ok(None);
    }
    Ok(anchors::map_range(original, &current, range)?)
}

fn mapping_status(
    mapped: Result<Option<ReviewLineRange>, ReviewAnchorError>,
) -> (ReviewMappingStatus, Option<ReviewLineRange>) {
    match mapped {
        Ok(Some(range)) => (ReviewMappingStatus::Open, Some(range)),
        Ok(None) => (ReviewMappingStatus::Outdated, None),
        Err(_) => (ReviewMappingStatus::Unavailable, None),
    }
}

fn map_thread(repo: &Repository, head: Oid, thread: ReviewMappingRequest) -> MappedReviewThread {
    let mapped = (|| {
        let retained = repo
            .refname_to_id(&ref_name(thread.thread_id))
            .map_err(|error| {
                if error.code() == ErrorCode::NotFound {
                    ReviewAnchorError::ContentUnavailable
                } else {
                    error.into()
                }
            })?;
        if retained != Oid::from_str(&thread.original_blob_id)? {
            return Err(ReviewAnchorError::ContentUnavailable);
        }
        let blob = repo.find_blob(retained)?;
        map_onto(repo, head, blob.content(), thread.range, &thread.location)
    })();
    let (status, range) = mapping_status(mapped);
    MappedReviewThread {
        thread_id: thread.thread_id,
        start_line: range.map(|range| range.start_line),
        line: range.map(|range| range.line),
        status,
    }
}

/// Where lines `range` of the shown worktree `from` are in `onto` (such as
/// the PR's published side), unchanged. Reads only: nothing is retained or
/// saved.
#[tauri::command]
#[specta::specta]
pub async fn map_review_selection(
    worktree: String,
    from: ReviewAnchorLocation,
    range: ReviewLineRange,
    onto: ReviewAnchorLocation,
) -> Result<MappedReviewRange, ReviewAnchorError> {
    git_job(move || {
        let (repo, head) = open(&worktree)?;
        Ok(map_selection(&repo, head, &from, range, &onto))
    })
    .await
}

fn map_selection(
    repo: &Repository,
    head: Oid,
    from: &ReviewAnchorLocation,
    range: ReviewLineRange,
    onto: &ReviewAnchorLocation,
) -> MappedReviewRange {
    let mapped = worktree_content(repo, head, from)
        .and_then(|original| original.ok_or(ReviewAnchorError::ContentUnavailable))
        .and_then(|original| map_onto(repo, head, &original, range, onto));
    let (status, range) = mapping_status(mapped);
    MappedReviewRange {
        start_line: range.map(|range| range.start_line),
        line: range.map(|range| range.line),
        status,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn read_review_anchor(
    worktree: String,
    thread_id: Uuid,
    range: ReviewLineRange,
) -> Result<String, ReviewAnchorError> {
    git_job(move || {
        let repo = repository(&worktree)?;
        let blob = repo.find_blob(repo.refname_to_id(&ref_name(thread_id))?)?;
        String::from_utf8(range.slice(blob.content())?.to_vec())
            .map_err(|_| ReviewAnchorError::ContentUnavailable)
    })
    .await
}

#[cfg(test)]
mod tests;
