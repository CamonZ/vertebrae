//! Per-runtime recorder: turns root tool boundaries into checkpoint segments
//! and appends one `worktree_delta` annotation per completed root tool call
//! that changed the worktree.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, Notify};

use super::git::{self, GitError, Limits, Snapshot};
use super::patch::{self, FileEntry};
use crate::local_chat::{LocalChatAnnotation, LocalChatAnnotationStore};

pub(crate) const WORKTREE_DELTA_KIND: &str = "worktree_delta";

/// Which event pair delimits a root tool window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Boundary {
    /// `ToolCall` -> `ToolOutput`.
    ToolCall,
    /// First started `FileChange` -> terminal `FileChange` (Codex fileChange).
    FileChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecorderEvent {
    Started {
        tool_id: String,
        boundary: Boundary,
    },
    Finished {
        tool_id: String,
        boundary: Boundary,
    },
    /// Activity of a subagent stream, attributed to its spawning root tool.
    Child {
        parent_tool_id: Option<String>,
    },
    TurnEnded,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RecorderConfig {
    pub(crate) settle_delay: Duration,
    pub(crate) settle_interval: Duration,
    pub(crate) settle_timeout: Duration,
    pub(crate) channel_capacity: usize,
    pub(crate) limits: Limits,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            settle_delay: Duration::from_millis(300),
            settle_interval: Duration::from_millis(100),
            settle_timeout: Duration::from_secs(3),
            channel_capacity: 512,
            limits: Limits::default(),
        }
    }
}

/// Shared between a recorder task and its tap. Deactivation waits for an
/// append in progress, so nothing is appended after a recorder is torn down.
#[derive(Debug)]
pub(crate) struct RecorderGate {
    active: Mutex<bool>,
    overflowed: AtomicBool,
    /// Root tool starts queued but not yet processed; one ends a settle early.
    pending_starts: AtomicUsize,
    start_signal: Notify,
}

impl RecorderGate {
    pub(crate) fn new() -> Self {
        Self {
            active: Mutex::new(true),
            overflowed: AtomicBool::new(false),
            pending_starts: AtomicUsize::new(0),
            start_signal: Notify::new(),
        }
    }

    pub(crate) fn start_queued(&self) {
        self.pending_starts.fetch_add(1, Ordering::AcqRel);
        self.start_signal.notify_one();
    }

    pub(crate) fn start_dequeued(&self) {
        let _ = self
            .pending_starts
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            });
    }

    fn start_pending(&self) -> bool {
        self.pending_starts.load(Ordering::Acquire) > 0
    }

    pub(crate) fn is_active(&self) -> bool {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn deactivate(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }

    /// Returns whether this is the first overflow since the recorder last
    /// reset, so the caller warns once per lost segment.
    pub(crate) fn mark_overflow(&self) -> bool {
        !self.overflowed.swap(true, Ordering::AcqRel)
    }

    fn take_overflow(&self) -> bool {
        self.overflowed.swap(false, Ordering::AcqRel)
    }

    fn while_active<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.then(operation)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClosedWindow {
    pub(crate) tool_id: String,
    pub(crate) aggregate: bool,
    pub(crate) overlapping: bool,
}

#[derive(Debug)]
struct Window {
    tool_id: String,
    boundary: Boundary,
    aggregate: bool,
    overlapping: bool,
}

/// Open root tool windows of one runtime.
#[derive(Debug, Default)]
pub(crate) struct Windows {
    open: Vec<Window>,
    finished: HashSet<String>,
}

impl Windows {
    /// Opens a window; returns `Some(true)` when it is the only open one and
    /// therefore needs a fresh baseline. Repeated starts are ignored.
    pub(crate) fn start(&mut self, tool_id: &str, boundary: Boundary) -> Option<bool> {
        if self.finished.contains(tool_id) || self.open.iter().any(|w| w.tool_id == tool_id) {
            return None;
        }
        self.open.push(Window {
            tool_id: tool_id.to_string(),
            boundary,
            aggregate: false,
            overlapping: false,
        });
        if self.open.len() > 1 {
            for window in &mut self.open {
                window.overlapping = true;
            }
        }
        Some(self.open.len() == 1)
    }

    pub(crate) fn finish(&mut self, tool_id: &str, boundary: Boundary) -> Option<ClosedWindow> {
        let position = self
            .open
            .iter()
            .position(|w| w.tool_id == tool_id && w.boundary == boundary)?;
        let window = self.open.remove(position);
        self.finished.insert(window.tool_id.clone());
        Some(ClosedWindow {
            tool_id: window.tool_id,
            aggregate: window.aggregate,
            overlapping: window.overlapping,
        })
    }

    /// Child activity marks its spawning window, or every open window when
    /// the parent is not an open root tool.
    pub(crate) fn child(&mut self, parent_tool_id: Option<&str>) {
        let parent =
            parent_tool_id.and_then(|parent| self.open.iter().position(|w| w.tool_id == parent));
        match parent {
            Some(index) => self.open[index].aggregate = true,
            None => self.open.iter_mut().for_each(|w| w.aggregate = true),
        }
    }

    /// Drops every open window; returns their tool ids.
    pub(crate) fn drop_all(&mut self) -> Vec<String> {
        self.open.drain(..).map(|window| window.tool_id).collect()
    }

    pub(crate) fn end_turn(&mut self) -> Vec<String> {
        self.finished.clear();
        self.drop_all()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.open.is_empty()
    }
}

#[derive(Debug, Serialize)]
struct WorktreeDeltaPayload {
    worktree: String,
    base_head: Option<String>,
    head_changed: bool,
    aggregate: bool,
    overlapping: bool,
    patch: String,
    files: Vec<FileEntry>,
}

pub(crate) struct Recorder {
    pub(crate) chat_session_id: String,
    pub(crate) worktree: PathBuf,
    pub(crate) store: LocalChatAnnotationStore,
    pub(crate) config: RecorderConfig,
    pub(crate) gate: Arc<RecorderGate>,
}

impl Recorder {
    pub(crate) async fn run(self, mut events: mpsc::Receiver<RecorderEvent>) {
        let mut windows = Windows::default();
        let mut checkpoint: Option<Arc<Snapshot>> = None;
        // End state of a settle cut short by a queued start: that start's
        // baseline, so nothing between the two tools is lost or doubled.
        let mut handoff: Option<Arc<Snapshot>> = None;
        while let Some(event) = events.recv().await {
            if !self.gate.is_active() {
                break;
            }
            if self.gate.take_overflow() {
                // Boundaries were lost: discard the backlog with every open
                // window rather than attribute a segment to the wrong tool.
                let dropped = windows.drop_all();
                checkpoint = None;
                handoff = None;
                while let Ok(event) = events.try_recv() {
                    if matches!(event, RecorderEvent::Started { .. }) {
                        self.gate.start_dequeued();
                    }
                }
                log::debug!(
                    "[WORKTREE_DELTA] dropped open windows {dropped:?} after a recorder overflow"
                );
                continue;
            }
            match event {
                RecorderEvent::Started { tool_id, boundary } => {
                    self.gate.start_dequeued();
                    let handed_off = handoff.take();
                    if windows.start(&tool_id, boundary) == Some(true) {
                        checkpoint = match handed_off {
                            Some(snapshot) => Some(snapshot),
                            None => self.snapshot().await.map(Arc::new).ok(),
                        };
                    }
                }
                RecorderEvent::Finished { tool_id, boundary } => {
                    let Some(window) = windows.finish(&tool_id, boundary) else {
                        continue;
                    };
                    // A tool that left the worktree as it found it needs no
                    // settle: one snapshot equal to the checkpoint ends it.
                    let unchanged = match &checkpoint {
                        Some(start) => self
                            .snapshot()
                            .await
                            .ok()
                            .filter(|now| now.agrees_with(start)),
                        None => None,
                    };
                    let (end, cut_short, unchanged) = match unchanged {
                        Some(now) => (Ok(Arc::new(now)), false, true),
                        None => {
                            let settled = self.settle().await;
                            let cut_short = matches!(settled, Ok((_, true)));
                            (
                                settled.map(|(snapshot, _)| Arc::new(snapshot)),
                                cut_short,
                                false,
                            )
                        }
                    };
                    if let Err(error) = &end {
                        log::warn!(
                            "[WORKTREE_DELTA] skipping tool {tool_id}: could not snapshot {}: {error}",
                            self.worktree.display()
                        );
                    }
                    match (checkpoint.take(), &end) {
                        (Some(_), Ok(_)) if unchanged => {}
                        (Some(start), Ok(end)) => self.record(window, start, end.clone()).await,
                        (None, Ok(_)) => log::warn!(
                            "[WORKTREE_DELTA] skipping tool {tool_id}: no baseline for {}",
                            self.worktree.display()
                        ),
                        (_, Err(_)) => {}
                    }
                    if windows.is_empty() {
                        checkpoint = None;
                        handoff = end.ok().filter(|_| cut_short);
                    } else {
                        checkpoint = end.ok();
                    }
                }
                RecorderEvent::Child { parent_tool_id } => windows.child(parent_tool_id.as_deref()),
                RecorderEvent::TurnEnded => {
                    let dropped = windows.end_turn();
                    checkpoint = None;
                    handoff = None;
                    if !dropped.is_empty() {
                        log::debug!(
                            "[WORKTREE_DELTA] dropped windows {dropped:?} still open at turn end"
                        );
                    }
                }
            }
        }
        let dropped = windows.drop_all();
        if !dropped.is_empty() {
            log::debug!("[WORKTREE_DELTA] recorder stopped with open windows {dropped:?}");
        }
    }

    async fn snapshot(&self) -> Result<Snapshot, GitError> {
        let worktree = self.worktree.clone();
        let limits = self.config.limits;
        let result = tokio::task::spawn_blocking(move || git::snapshot(&worktree, &limits))
            .await
            .unwrap_or_else(|error| Err(GitError::Task(error.to_string())));
        if let Err(error) = &result {
            log::warn!(
                "[WORKTREE_DELTA] could not checkpoint {}: {error}",
                self.worktree.display()
            );
        }
        result
    }

    /// Wait, then re-snapshot until two consecutive snapshots agree or the
    /// settle timeout passes; the last snapshot wins. A queued root tool
    /// start ends the settle at once: its tool has begun, so the snapshot
    /// taken now closes this segment. Returns whether it was cut short.
    async fn settle(&self) -> Result<(Snapshot, bool), GitError> {
        let deadline = tokio::time::Instant::now() + self.config.settle_timeout;
        if !self.wait_unless_started(self.config.settle_delay).await {
            return Ok((self.snapshot().await?, true));
        }
        let mut last = self.snapshot().await?;
        while tokio::time::Instant::now() < deadline && self.gate.is_active() {
            if !self.wait_unless_started(self.config.settle_interval).await {
                return Ok((self.snapshot().await?, true));
            }
            let next = self.snapshot().await?;
            if next.agrees_with(&last) {
                return Ok((next, false));
            }
            last = next;
        }
        Ok((last, false))
    }

    /// Sleep for `duration`; returns false as soon as a root tool start is
    /// queued.
    async fn wait_unless_started(&self, duration: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + duration;
        loop {
            if self.gate.start_pending() {
                return false;
            }
            let signal = self.gate.start_signal.notified();
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return !self.gate.start_pending(),
                () = signal => {}
            }
        }
    }

    async fn record(&self, window: ClosedWindow, start: Arc<Snapshot>, end: Arc<Snapshot>) {
        let worktree = self.worktree.clone();
        let limits = self.config.limits;
        let store = self.store.clone();
        let gate = self.gate.clone();
        let chat_session_id = self.chat_session_id.clone();
        let tool_id = window.tool_id.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let delta = patch::compute(&worktree, &start, &end, &limits)?;
            if delta.files.is_empty() {
                return Ok(None);
            }
            let payload = WorktreeDeltaPayload {
                worktree: worktree.to_string_lossy().into_owned(),
                base_head: delta.base_head,
                head_changed: delta.head_changed,
                aggregate: window.aggregate,
                overlapping: window.overlapping,
                patch: delta.patch,
                files: delta.files,
            };
            let payload = serde_json::to_value(payload)
                .map_err(|error| GitError::Malformed(error.to_string()))?;
            let annotation = LocalChatAnnotation::new(
                chat_session_id,
                window.tool_id,
                WORKTREE_DELTA_KIND,
                payload,
            );
            Ok(gate.while_active(|| store.append(annotation)))
        })
        .await
        .unwrap_or_else(|error| Err(GitError::Task(error.to_string())));
        match outcome {
            Ok(Some(Ok(()))) => {}
            Ok(Some(Err(error))) => {
                log::warn!("[WORKTREE_DELTA] could not record tool {tool_id}: {error}")
            }
            Ok(None) => {
                log::debug!("[WORKTREE_DELTA] tool {tool_id}: no change or recorder stopped")
            }
            Err(error) => log::warn!(
                "[WORKTREE_DELTA] skipping tool {tool_id} in {}: {error}",
                self.worktree.display()
            ),
        }
    }
}
