//! Local Git storage and line mapping for review threads.

use std::path::Path;

use git2::{DiffOptions, ErrorCode, Oid, Patch, Repository};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::local_chat::{
    annotations::LocalChatAnnotationStore,
    file_history::{self, HistoryRead},
    worktree_delta::git::{self, CacheBudget, Limits, Side},
    worktree_files,
};

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

#[derive(Clone, Copy, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLineRange {
    start_line: u32,
    line: u32,
}

impl ReviewLineRange {
    fn slice(self, bytes: &[u8]) -> Result<&[u8], ReviewAnchorError> {
        if self.start_line == 0 || self.line < self.start_line {
            return Err(ReviewAnchorError::InvalidRange);
        }
        let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
        let start = lines
            .by_ref()
            .take((self.start_line - 1) as usize)
            .map(<[u8]>::len)
            .sum();
        let mut end = start;
        for _ in self.start_line..=self.line {
            end += lines.next().ok_or(ReviewAnchorError::InvalidRange)?.len();
        }
        Ok(&bytes[start..end])
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
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorParent {
    chat_id: String,
    project_path: Option<String>,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnchorRequest {
    worktree: String,
    thread_id: Uuid,
    location: ReviewAnchorLocation,
    range: ReviewLineRange,
    selected_text: String,
    parent: Option<ReviewAnchorParent>,
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

fn repository(folder: &str) -> Result<Repository, ReviewAnchorError> {
    let repo = Repository::discover(folder).map_err(|_| ReviewAnchorError::NotRepository)?;
    if repo.is_bare() {
        return Err(ReviewAnchorError::NotRepository);
    }
    Ok(repo)
}

fn open(worktree: &str) -> Result<(Repository, Oid), ReviewAnchorError> {
    let repo = repository(worktree)?;
    let head = open_head(&repo)?;
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
    let path = Path::new(&relative);
    match &location.source {
        ReviewAnchorSource::ToolCall { .. } | ReviewAnchorSource::FullFile { .. } => {
            Err(ReviewAnchorError::ContentUnavailable)
        }
        ReviewAnchorSource::Worktree { commit: None }
            if location.side == ReviewThreadSide::Right =>
        {
            // The app only opens user-selected checkouts. Within that trust
            // boundary, reject directory symlinks before the recorder reads
            // the Git path. The final component may itself be a Git symlink.
            let root = repo
                .workdir()
                .ok_or(ReviewAnchorError::NotRepository)?
                .canonicalize()
                .map_err(|_| ReviewAnchorError::InvalidPath)?;
            let parent = root.join(path.parent().ok_or(ReviewAnchorError::InvalidPath)?);
            match parent.canonicalize() {
                Ok(resolved) if resolved == parent => {}
                Ok(_) => return Err(ReviewAnchorError::InvalidPath),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    return Ok(None)
                }
                Err(_) => return Err(ReviewAnchorError::ContentUnavailable),
            }
            let limits = Limits::default();
            match git::read_side(&root, &relative, &limits, &mut CacheBudget::new(&limits)) {
                Side::Content { bytes, .. } => Ok(Some(bytes.to_vec())),
                Side::Absent => Ok(None),
                _ => Err(ReviewAnchorError::ContentUnavailable),
            }
        }
        ReviewAnchorSource::Worktree { commit } => {
            let commit = commit
                .as_deref()
                .map(Oid::from_str)
                .transpose()?
                .unwrap_or(head);
            let tree = repo.find_commit(commit)?.tree()?;
            match tree.get_path(path) {
                Ok(entry) => {
                    let (size, kind) = repo.odb()?.read_header(entry.id())?;
                    if kind != git2::ObjectType::Blob || size as u64 > Limits::default().side_bytes
                    {
                        return Err(ReviewAnchorError::ContentUnavailable);
                    }
                    Ok(Some(repo.find_blob(entry.id())?.content().to_vec()))
                }
                Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            }
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

fn map_range(
    original: &[u8],
    current: &[u8],
    range: ReviewLineRange,
) -> Result<Option<ReviewLineRange>, ReviewAnchorError> {
    let anchored = range.slice(original)?;
    let mut options = DiffOptions::new();
    options.context_lines(0).force_text(true);
    let patch = Patch::from_buffers(original, None, current, None, Some(&mut options))?;
    let mut offset = 0_i64;
    for index in 0..patch.num_hunks() {
        let (hunk, _) = patch.hunk(index)?;
        let start = hunk.old_start();
        let removed = hunk.old_lines();
        if removed == 0 {
            if start >= range.line {
                break;
            }
            if start >= range.start_line {
                return Ok(None);
            }
        } else {
            if start > range.line {
                break;
            }
            if start + removed > range.start_line {
                return Ok(None);
            }
        }
        offset += i64::from(hunk.new_lines()) - i64::from(removed);
    }

    let mapped = ReviewLineRange {
        start_line: u32::try_from(i64::from(range.start_line) + offset)
            .map_err(|_| ReviewAnchorError::InvalidRange)?,
        line: u32::try_from(i64::from(range.line) + offset)
            .map_err(|_| ReviewAnchorError::InvalidRange)?,
    };
    Ok((mapped.slice(current).ok() == Some(anchored)).then_some(mapped))
}

/// Where an anchor published on a remote (GitHub) diff lands in the shown
/// comparison side, by the same line mapping local threads use.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PublishedPlacement {
    /// The anchored lines are unchanged; they now sit at this range.
    Mapped { start_line: u32, line: u32 },
    /// Local edits changed the anchored lines.
    Edited,
    /// The file is absent from the shown side.
    Missing,
}

/// One side of a comparison: a commit, or the working tree (`None`).
fn side_content(
    repo: &Repository,
    commit: Option<Oid>,
    path: &str,
    side: ReviewThreadSide,
) -> Result<Option<Vec<u8>>, ReviewAnchorError> {
    let location = ReviewAnchorLocation {
        path: path.to_owned(),
        side,
        source: ReviewAnchorSource::Worktree {
            commit: commit.map(|oid| oid.to_string()),
        },
    };
    let head = match commit {
        Some(oid) => oid,
        None => open_head(repo)?,
    };
    let bytes = worktree_content(repo, head, &location)?;
    Ok(bytes.filter(|bytes| std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0)))
}

fn open_head(repo: &Repository) -> Result<Oid, ReviewAnchorError> {
    Ok(repo
        .head()
        .map_err(|error| match error.code() {
            ErrorCode::UnbornBranch | ErrorCode::NotFound => ReviewAnchorError::UnbornHead,
            _ => error.into(),
        })?
        .peel_to_commit()?
        .id())
}

/// Map lines `start_line..=line` of `path` at the `published` commit onto
/// the shown side (`shown`, or the working tree when `None`).
pub(crate) fn place_published_anchor(
    repo: &Repository,
    published: Oid,
    shown: Option<Oid>,
    path: &str,
    side: ReviewThreadSide,
    start_line: u32,
    line: u32,
) -> Result<PublishedPlacement, ReviewAnchorError> {
    let original = side_content(repo, Some(published), path, side)?
        .ok_or(ReviewAnchorError::ContentUnavailable)?;
    let Some(current) = side_content(repo, shown, path, side)? else {
        return Ok(PublishedPlacement::Missing);
    };
    Ok(
        match map_range(&original, &current, ReviewLineRange { start_line, line })? {
            Some(range) => PublishedPlacement::Mapped {
                start_line: range.start_line,
                line: range.line,
            },
            None => PublishedPlacement::Edited,
        },
    )
}

/// Lines `from..=to` (1-based, clamped to the file) of `path` at `commit`,
/// with their line numbers, without line endings.
pub(crate) fn commit_lines(
    repo: &Repository,
    commit: Oid,
    path: &str,
    from: u32,
    to: u32,
) -> Result<Vec<(u32, String)>, ReviewAnchorError> {
    let bytes = side_content(repo, Some(commit), path, ReviewThreadSide::Right)?
        .ok_or(ReviewAnchorError::ContentUnavailable)?;
    let text = String::from_utf8(bytes).map_err(|_| ReviewAnchorError::ContentUnavailable)?;
    Ok(text
        .lines()
        .zip(1_u32..)
        .filter(|(_, number)| (from.max(1)..=to).contains(number))
        .map(|(line, number)| (number, line.strip_suffix('\r').unwrap_or(line).to_owned()))
        .collect())
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
        selected_text,
        parent,
    } = request;
    let parent = parent.ok_or(ReviewAnchorError::ParentUnavailable)?;
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
        if !selected_text_matches(snippet, &selected_text) {
            return Err(ReviewAnchorError::ContentUnavailable);
        }
        let blob = capture(&repo, thread_id, &bytes)?;
        Ok((
            CapturedReviewAnchor {
                original_commit_id: head.to_string(),
                original_blob_id: blob.to_string(),
            },
            location,
            common_dir,
        ))
    })
    .await?;

    let (home_kind, tool_use_id, origin_ref) = match location.source {
        ReviewAnchorSource::ToolCall { tool_use_id, .. } => {
            (ReviewThreadHome::ToolCall, Some(tool_use_id), None)
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
    };
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
        let Some(current) = worktree_content(repo, head, &thread.location)? else {
            return Ok(None);
        };
        if std::str::from_utf8(&current).is_err() || current.contains(&0) {
            return Ok(None);
        }
        map_range(blob.content(), &current, thread.range)
    })();
    let (status, range) = match mapped {
        Ok(Some(range)) => (ReviewMappingStatus::Open, Some(range)),
        Ok(None) => (ReviewMappingStatus::Outdated, None),
        Err(_) => (ReviewMappingStatus::Unavailable, None),
    };
    MappedReviewThread {
        thread_id: thread.thread_id,
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
mod tests {
    use super::*;
    use std::process::Command;

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn mapping_follows_only_contiguous_unchanged_lines() {
        let original = b"before\nfirst\nsecond\nafter\n";
        let range = ReviewLineRange {
            start_line: 2,
            line: 3,
        };
        for (current, expected) in [
            (&b"before\nfirst\nsecond\nafter\n"[..], Some((2, 3))),
            (&b"new\nbefore\nfirst\nsecond\nafter\n"[..], Some((3, 4))),
            (&b"before\nnew\nfirst\nsecond\nafter\n"[..], Some((3, 4))),
            (&b"first\nsecond\nafter\n"[..], Some((1, 2))),
            (&b"before\nfirst\nsecond\nnew\nafter\n"[..], Some((2, 3))),
            (&b"before\nfirst\nnew\nsecond\nafter\n"[..], None),
            (&b"before\nfirst\nedited\nafter\n"[..], None),
            (&b"before\nsecond\nafter\n"[..], None),
            (&b""[..], None),
        ] {
            for _ in 0..2 {
                let mapped = map_range(original, current, range).unwrap();
                assert_eq!(mapped.map(|r| (r.start_line, r.line)), expected);
                if let Some(mapped) = mapped {
                    assert_eq!(
                        mapped.slice(current).unwrap(),
                        range.slice(original).unwrap()
                    );
                }
            }
        }
    }

    #[hegel::test]
    fn line_mapping_matches_a_generated_edit_oracle(tc: hegel::TestCase) {
        use hegel::generators as gs;
        use std::collections::BTreeMap;
        let count = tc.draw(gs::integers::<usize>().min_value(4).max_value(30));
        let start = tc.draw(gs::integers::<usize>().max_value(count - 1));
        let end = tc.draw(
            gs::integers::<usize>()
                .min_value(start)
                .max_value(count - 1),
        );
        let original: Vec<_> = (0..count).map(|index| format!("line-{index}\n")).collect();
        // Assign two or three edits to distinct original lines. Track original
        // identities through the edits to find the range without diffing text.
        let edit_count = tc.draw(gs::integers::<usize>().min_value(2).max_value(3));
        let mut edits = BTreeMap::new();
        let mut candidates: Vec<_> = (0..count).collect();
        for _ in 0..edit_count {
            let index = tc.draw(gs::integers::<usize>().max_value(candidates.len() - 1));
            let operation = tc.draw(gs::integers::<u8>().max_value(2));
            edits.insert(candidates.swap_remove(index), operation);
        }
        let mut current = String::new();
        let mut surviving = Vec::new();
        let mut current_line = 0;
        for (index, line) in original.iter().enumerate() {
            match edits.get(&index) {
                Some(0) => {
                    current.push_str(&format!("inserted-{index}\n"));
                    current_line += 1;
                }
                Some(1) => continue,
                Some(2) => {
                    current.push_str(&format!("edited-{index}\n"));
                    current_line += 1;
                    continue;
                }
                _ => {}
            }
            if (start..=end).contains(&index) {
                surviving.push(current_line);
            }
            current.push_str(line);
            current_line += 1;
        }
        let expected = (surviving.len() == end - start + 1
            && surviving
                .windows(2)
                .all(|window| window[1] == window[0] + 1))
        .then(|| surviving[0]);
        let original = original.concat();
        let range = ReviewLineRange {
            start_line: start as u32 + 1,
            line: end as u32 + 1,
        };
        let mapped = map_range(original.as_bytes(), current.as_bytes(), range).unwrap();
        assert_eq!(
            mapped.map(|range| range.start_line),
            expected.map(|start| start as u32 + 1)
        );
        if let Some(mapped) = mapped {
            assert_eq!(
                range.slice(original.as_bytes()).unwrap(),
                mapped.slice(current.as_bytes()).unwrap()
            );
        }
    }

    #[test]
    fn mapping_survives_repeated_lines_and_no_final_newline() {
        let range = ReviewLineRange {
            start_line: 2,
            line: 3,
        };
        let mapped = map_range(b"same\nsame\nend", b"inserted\nsame\nsame\nend", range)
            .unwrap()
            .unwrap();
        assert_eq!((mapped.start_line, mapped.line), (3, 4));
    }

    #[test]
    fn crlf_selection_comparison_accepts_rendered_text_and_rejects_edits() {
        assert!(selected_text_matches("a\r\nb\r\n", "a\nb"));
        assert!(selected_text_matches("a\r\nb\r\n", "a\r\nb\r"));
        assert!(!selected_text_matches("a\r\nb\r\n", "a\nc"));
    }

    fn working_location(path: &str) -> ReviewAnchorLocation {
        ReviewAnchorLocation {
            path: path.into(),
            side: ReviewThreadSide::Right,
            source: ReviewAnchorSource::Worktree { commit: None },
        }
    }

    #[test]
    fn full_file_anchor_maps_lines_in_a_clean_file_without_diff_hunks() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let path = dir.path().join("a");
        std::fs::write(&path, "first\nselected\nthird\n").unwrap();
        git(dir.path(), &["add", "a"]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-m",
                "fixture",
            ],
        );
        let mut location = working_location("a");
        location.source = ReviewAnchorSource::FullFile { turn: None };
        let head = repo.blob(b"").unwrap();
        let bytes = worktree_content(&repo, head, &location).unwrap().unwrap();
        let range = ReviewLineRange {
            start_line: 2,
            line: 2,
        };
        let snippet = std::str::from_utf8(range.slice(&bytes).unwrap()).unwrap();
        assert!(selected_text_matches(snippet, "selected"));
        assert!(!selected_text_matches(snippet, "unsaved"));

        let thread_id = Uuid::new_v4();
        let blob = capture(&repo, thread_id, &bytes).unwrap();
        drop(repo);
        let repo = Repository::open(dir.path()).unwrap();
        let retained = repo
            .find_blob(repo.refname_to_id(&ref_name(thread_id)).unwrap())
            .unwrap();
        assert_eq!(range.slice(retained.content()).unwrap(), b"selected\n");

        std::fs::write(path, "inserted\nfirst\nselected\nthird\n").unwrap();
        let mapped = map_thread(
            &repo,
            head,
            ReviewMappingRequest {
                thread_id,
                original_blob_id: blob.to_string(),
                range,
                location,
            },
        );
        assert_eq!(mapped.status, ReviewMappingStatus::Open);
        assert_eq!((mapped.start_line, mapped.line), (Some(3), Some(3)));
    }

    #[test]
    fn invalid_threads_do_not_prevent_a_valid_mapping() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("valid"), "shift\nselected\n").unwrap();
        std::fs::write(dir.path().join("binary"), b"selected\0\n").unwrap();
        std::fs::write(dir.path().join("non-utf8"), [0xff]).unwrap();
        std::fs::write(
            dir.path().join("large"),
            vec![b'a'; Limits::default().side_bytes as usize + 1],
        )
        .unwrap();
        let valid = Uuid::new_v4();
        let blob = capture(&repo, valid, b"selected\n").unwrap();
        let other_blob = repo.blob(b"different\n").unwrap();
        use ReviewMappingStatus::{Open, Outdated, Unavailable};
        let requests = [
            (Uuid::new_v4(), blob, "valid", 1, Unavailable, None),
            (valid, other_blob, "valid", 1, Unavailable, None),
            (valid, blob, "binary", 1, Outdated, None),
            (valid, blob, "non-utf8", 1, Outdated, None),
            (valid, blob, "large", 1, Unavailable, None),
            (valid, blob, "missing", 1, Outdated, None),
            (valid, blob, "valid", 2, Unavailable, None),
            (valid, blob, "valid", 1, Open, Some(2)),
        ];
        for (thread_id, original, path, line, status, position) in requests {
            let mapped = map_thread(
                &repo,
                blob,
                ReviewMappingRequest {
                    thread_id,
                    original_blob_id: original.to_string(),
                    location: working_location(path),
                    range: ReviewLineRange {
                        start_line: line,
                        line,
                    },
                },
            );
            assert_eq!(mapped.status, status, "{path}, line {line}");
            assert_eq!((mapped.start_line, mapped.line), (position, position));
        }
    }

    #[test]
    fn git_failure_is_unavailable_and_a_retry_maps_normally() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("a"), "selected\n").unwrap();
        let thread_id = Uuid::new_v4();
        let blob = capture(&repo, thread_id, b"selected\n").unwrap();
        let request = |location| ReviewMappingRequest {
            thread_id,
            original_blob_id: blob.to_string(),
            range: ReviewLineRange {
                start_line: 1,
                line: 1,
            },
            location,
        };
        // Ask Git for a commit which is temporarily unavailable locally.
        let mut location = working_location("a");
        location.source = ReviewAnchorSource::Worktree {
            commit: Some("a".repeat(40)),
        };
        let failed = map_thread(&repo, blob, request(location));
        assert_eq!(failed.status, ReviewMappingStatus::Unavailable);
        assert_eq!((failed.start_line, failed.line), (None, None));
        let retry = map_thread(&repo, blob, request(working_location("a")));
        assert_eq!(retry.status, ReviewMappingStatus::Open);
        assert_eq!((retry.start_line, retry.line), (Some(1), Some(1)));
    }

    #[test]
    fn left_side_reads_the_explicit_base_commit_and_rejects_trees() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        Repository::init(path).unwrap();
        std::fs::create_dir(path.join("folder")).unwrap();
        std::fs::write(path.join("folder/file"), "base\n").unwrap();
        git(path, &["add", "folder"]);
        git(
            path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-m",
                "base",
            ],
        );
        let (repo, base) = open(path.to_str().unwrap()).unwrap();
        std::fs::write(path.join("folder/file"), "head\n").unwrap();
        git(path, &["add", "folder/file"]);
        git(
            path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-m",
                "head",
            ],
        );
        let (_, head) = open(path.to_str().unwrap()).unwrap();
        let mut location = ReviewAnchorLocation {
            path: "folder/file".into(),
            side: ReviewThreadSide::Left,
            source: ReviewAnchorSource::Worktree {
                commit: Some(base.to_string()),
            },
        };
        assert_eq!(
            worktree_content(&repo, head, &location).unwrap().as_deref(),
            Some(&b"base\n"[..])
        );
        location.path = "folder".into();
        assert!(matches!(
            worktree_content(&repo, head, &location),
            Err(ReviewAnchorError::ContentUnavailable)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_content_rejects_a_symlinked_parent() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        std::fs::write(outside.path().join("a"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(matches!(
            worktree_content(&repo, repo.blob(b"").unwrap(), &working_location("link/a")),
            Err(ReviewAnchorError::InvalidPath)
        ));
    }

    #[test]
    fn tool_anchor_uses_the_post_image_and_rejects_the_left_side() {
        use crate::local_chat::{annotations::LocalChatAnnotation, events::LocalChatEventSink};
        use serde_json::json;

        let worktree = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(worktree.path()).unwrap();
        std::fs::write(worktree.path().join("a"), "later edit\n").unwrap();
        let annotations = LocalChatAnnotationStore::new(
            Ok(directory.path().into()),
            LocalChatEventSink::inert_for_tests(),
        );
        let entry = LocalChatAnnotation::new(
            "chat",
            "tool",
            "worktree_delta",
            json!({
                "review_post_images": {"a": "post-image\n"},
            }),
        );
        assert!(entry
            .clone()
            .frontend()
            .payload
            .get("review_post_images")
            .is_none());
        annotations.append(entry).unwrap();

        let mut location = ReviewAnchorLocation {
            path: "a".into(),
            side: ReviewThreadSide::Right,
            source: ReviewAnchorSource::ToolCall {
                chat_id: "chat".into(),
                tool_use_id: "tool".into(),
            },
        };
        let head = repo.blob(b"").unwrap();
        assert_eq!(
            content(&repo, head, &location, &annotations)
                .unwrap()
                .as_deref(),
            Some(&b"post-image\n"[..])
        );
        location.side = ReviewThreadSide::Left;
        assert!(matches!(
            content(&repo, head, &location, &annotations),
            Err(ReviewAnchorError::ContentUnavailable)
        ));
    }

    #[test]
    fn requires_a_repository_with_a_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let worktree = path.to_str().unwrap();
        assert!(matches!(
            open(worktree),
            Err(ReviewAnchorError::NotRepository)
        ));
        Repository::init(path).unwrap();
        assert!(matches!(open(worktree), Err(ReviewAnchorError::UnbornHead)));
    }

    #[test]
    fn nested_folder_resolves_the_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        Repository::init(path).unwrap();
        git(
            path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "--allow-empty",
                "-m",
                "base",
            ],
        );
        let (repo, _) = open(path.to_str().unwrap()).unwrap();
        let nested = path.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert_eq!(
            open(nested.to_str().unwrap()).unwrap().0.path(),
            repo.path()
        );
    }

    #[test]
    fn retained_blob_survives_gc_and_release_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let repo = Repository::init(path).unwrap();
        let thread = Uuid::new_v4();
        let original = b"uncommitted\n";
        let id = capture(&repo, thread, original).unwrap();
        assert!(capture(&repo, thread, original).is_err());
        assert!(capture(&repo, thread, b"other\n").is_err());
        git(path, &["gc", "--prune=now"]);
        assert_eq!(repo.find_blob(id).unwrap().content(), original);
        assert_eq!(repo.refname_to_id(&ref_name(thread)).unwrap(), id);
        assert!(repo.index().unwrap().is_empty());
        release(&repo, thread).unwrap();
        release(&repo, thread).unwrap();
        assert!(repo.find_reference(&ref_name(thread)).is_err());
    }
}
