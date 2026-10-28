//! Vertebrae's own per-session metadata about tool calls. Each chat session
//! gets one append-only JSONL file next to the session index; provider
//! transcripts are never touched. Entries are keyed by the persistent chat
//! session id and the provider tool-call id, and `kind`/`payload` stay opaque.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::local_chat::events::{LocalChatEvent, LocalChatEventSink};

/// Upper bound for one serialized entry, newline included. Producers keep
/// payloads small; anything larger is rejected on append and skipped on load.
pub(crate) const MAX_ANNOTATION_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SESSION_ID_LEN: usize = 200;
const ANNOTATIONS_DIR: &str = "local-chat-annotations";
const ANNOTATIONS_EXTENSION: &str = "jsonl";

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct LocalChatAnnotation {
    pub session_id: String,
    pub tool_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
    /// RFC 3339 timestamp of when Vertebrae recorded the entry.
    pub recorded_at: String,
}

impl LocalChatAnnotation {
    pub(crate) fn new(
        session_id: impl Into<String>,
        tool_id: impl Into<String>,
        kind: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            tool_id: tool_id.into(),
            kind: kind.into(),
            payload,
            recorded_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatAnnotationEvent {
    pub session_id: String,
    pub annotation: LocalChatAnnotation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AnnotationStoreError {
    InvalidSessionId(String),
    InvalidAnnotation(String),
    TooLarge { bytes: usize },
    Unavailable(String),
    Io(String),
}

impl std::fmt::Display for AnnotationStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSessionId(id) => write!(formatter, "invalid chat session id {id:?}"),
            Self::InvalidAnnotation(reason) => write!(formatter, "invalid annotation: {reason}"),
            Self::TooLarge { bytes } => write!(
                formatter,
                "annotation is {bytes} bytes; the limit is {MAX_ANNOTATION_LINE_BYTES}"
            ),
            Self::Unavailable(reason) => {
                write!(formatter, "annotation store unavailable: {reason}")
            }
            Self::Io(reason) => write!(formatter, "annotation store I/O failed: {reason}"),
        }
    }
}

impl std::error::Error for AnnotationStoreError {}

/// Session ids become file names, so only a conservative character set is
/// accepted; separators, dots and anything else are rejected outright.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), AnnotationStoreError> {
    let valid = !session_id.is_empty()
        && session_id.len() <= MAX_SESSION_ID_LEN
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(AnnotationStoreError::InvalidSessionId(
            session_id.to_string(),
        ))
    }
}

/// Owns the metadata transcripts. Appends, deletes and sweeps of one session
/// are serialized by a per-session lock so lines never interleave. Clones
/// share the locks, so blocking work can move onto a worker thread.
#[derive(Clone)]
pub struct LocalChatAnnotationStore {
    directory: Result<PathBuf, String>,
    sink: LocalChatEventSink,
    session_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl LocalChatAnnotationStore {
    pub(crate) fn new(directory: Result<PathBuf, String>, sink: LocalChatEventSink) -> Self {
        Self {
            directory,
            sink,
            session_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Store rooted in the app data directory, next to the session index.
    pub(crate) fn in_app_data_dir(sink: LocalChatEventSink) -> Self {
        let directory = vertebrae_installer::data_dir()
            .map(|data_dir| data_dir.join(ANNOTATIONS_DIR))
            .map_err(|error| format!("could not determine app data directory: {error}"));
        if let Err(error) = &directory {
            log::warn!("[LOCAL_CHAT] annotations disabled: {error}");
        }
        Self::new(directory, sink)
    }

    fn directory(&self) -> Result<&Path, AnnotationStoreError> {
        self.directory
            .as_deref()
            .map_err(|error| AnnotationStoreError::Unavailable(error.clone()))
    }

    fn session_path(&self, session_id: &str) -> Result<PathBuf, AnnotationStoreError> {
        validate_session_id(session_id)?;
        Ok(self
            .directory()?
            .join(format!("{session_id}.{ANNOTATIONS_EXTENSION}")))
    }

    fn session_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self
            .session_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.entry(session_id.to_string()).or_default().clone()
    }

    /// Append one entry for a backend producer and notify open chat windows.
    /// The entry's `session_id` must be the persistent chat session id.
    pub(crate) fn append(
        &self,
        annotation: LocalChatAnnotation,
    ) -> Result<(), AnnotationStoreError> {
        let path = self.session_path(&annotation.session_id)?;
        if annotation.tool_id.is_empty() || annotation.kind.is_empty() {
            return Err(AnnotationStoreError::InvalidAnnotation(
                "tool_id and kind must not be empty".to_string(),
            ));
        }
        let mut line = serde_json::to_vec(&annotation)
            .map_err(|error| AnnotationStoreError::InvalidAnnotation(error.to_string()))?;
        line.push(b'\n');
        if line.len() > MAX_ANNOTATION_LINE_BYTES {
            return Err(AnnotationStoreError::TooLarge { bytes: line.len() });
        }

        let lock = self.session_lock(&annotation.session_id);
        let guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let written = fs::create_dir_all(self.directory()?)
            .and_then(|()| append_line(&path, &line))
            .map_err(|error| AnnotationStoreError::Io(error.to_string()));
        drop(guard);
        if let Err(error) = &written {
            log::warn!(
                "[LOCAL_CHAT] could not record annotation in {}: {error}",
                path.display()
            );
        }
        written?;

        let session_id = annotation.session_id.clone();
        if let Err(error) =
            self.sink
                .try_emit(LocalChatEvent::Annotation(LocalChatAnnotationEvent {
                    session_id,
                    annotation,
                }))
        {
            log::warn!("[LOCAL_CHAT] annotation event delivery failed: {error}");
        }
        Ok(())
    }

    /// Valid entries in file order, keeping only the last entry for a repeated
    /// `(tool_id, kind)`. Damaged lines are skipped with a warning.
    pub(crate) fn load(
        &self,
        session_id: &str,
    ) -> Result<Vec<LocalChatAnnotation>, AnnotationStoreError> {
        let path = self.session_path(session_id)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(AnnotationStoreError::Io(error.to_string())),
        };
        let entries = read_entries(BufReader::new(file), session_id, &path)
            .map_err(|error| AnnotationStoreError::Io(error.to_string()))?;
        Ok(last_entry_per_key(entries))
    }

    /// Remove a session's metadata transcript; an absent file is not an error.
    pub(crate) fn delete(&self, session_id: &str) -> Result<(), AnnotationStoreError> {
        let path = self.session_path(session_id)?;
        let lock = self.session_lock(session_id);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        remove_if_present(&path).map_err(|error| AnnotationStoreError::Io(error.to_string()))
    }

    /// Delete metadata transcripts whose session the GUI no longer knows.
    /// `known_session_ids` must come from a successfully read or written
    /// session index; sessions with a live runtime are always kept.
    pub(crate) fn sweep_orphans(
        &self,
        known_session_ids: &HashSet<String>,
        live_session_ids: &HashSet<String>,
    ) -> Result<Vec<String>, AnnotationStoreError> {
        let directory = self.directory()?;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(AnnotationStoreError::Io(error.to_string())),
        };
        let mut removed = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| AnnotationStoreError::Io(error.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str())
                != Some(ANNOTATIONS_EXTENSION)
            {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if validate_session_id(session_id).is_err()
                || known_session_ids.contains(session_id)
                || live_session_ids.contains(session_id)
            {
                continue;
            }
            let lock = self.session_lock(session_id);
            let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match remove_if_present(&path) {
                Ok(()) => removed.push(session_id.to_string()),
                Err(error) => log::warn!(
                    "[LOCAL_CHAT] could not remove orphaned annotations {}: {error}",
                    path.display()
                ),
            }
        }
        Ok(removed)
    }
}

/// Write one complete line. If a previous write left a partial last line,
/// terminate it first so the new entry is not glued onto the damaged one.
fn append_line(path: &Path, line: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)?;
    let length = file.metadata()?.len();
    let mut buffer = Vec::with_capacity(line.len() + 1);
    if length > 0 {
        let mut last = [0_u8; 1];
        file.seek(SeekFrom::Start(length - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            buffer.push(b'\n');
        }
    }
    buffer.extend_from_slice(line);
    file.write_all(&buffer)?;
    file.flush()
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Consume input up to and including the next newline without buffering it.
fn discard_rest_of_line(reader: &mut impl BufRead) -> std::io::Result<()> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(());
        }
        match available.iter().position(|byte| *byte == b'\n') {
            Some(newline) => {
                reader.consume(newline + 1);
                return Ok(());
            }
            None => {
                let length = available.len();
                reader.consume(length);
            }
        }
    }
}

fn read_entries(
    mut reader: impl BufRead,
    session_id: &str,
    path: &Path,
) -> std::io::Result<Vec<LocalChatAnnotation>> {
    let mut entries = Vec::new();
    let mut line = Vec::new();
    let mut line_number = 0_usize;
    loop {
        line.clear();
        line_number += 1;
        let read = reader
            .by_ref()
            .take(MAX_ANNOTATION_LINE_BYTES as u64)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if !line.ends_with(b"\n") && line.len() == MAX_ANNOTATION_LINE_BYTES {
            discard_rest_of_line(&mut reader)?;
            log::warn!(
                "[LOCAL_CHAT] skipping over-limit annotation {} line {line_number}",
                path.display()
            );
            continue;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        match serde_json::from_str::<LocalChatAnnotation>(text) {
            Ok(entry) if entry.session_id == session_id => entries.push(entry),
            Ok(entry) => log::warn!(
                "[LOCAL_CHAT] skipping annotation for session {:?} in {} line {line_number}",
                entry.session_id,
                path.display()
            ),
            Err(error) => log::warn!(
                "[LOCAL_CHAT] skipping malformed annotation {} line {line_number}: {error}",
                path.display()
            ),
        }
    }
    Ok(entries)
}

fn last_entry_per_key(entries: Vec<LocalChatAnnotation>) -> Vec<LocalChatAnnotation> {
    let mut seen = HashSet::new();
    let mut latest_first: Vec<_> = entries
        .into_iter()
        .rev()
        .filter(|entry| seen.insert((entry.tool_id.clone(), entry.kind.clone())))
        .collect();
    latest_first.reverse();
    latest_first
}

#[cfg(test)]
mod tests;
