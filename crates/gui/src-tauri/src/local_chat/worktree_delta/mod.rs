//! Records, per root tool call of a live local chat runtime, the change it
//! made to the session's associated Git worktree as a Git-format patch in the
//! annotation sidecar. Recording is read-only toward the worktree and never
//! blocks tool event delivery. Terminal events briefly await a durable turn
//! capture before the UI can dispatch the next turn.

pub(crate) mod git;
pub(crate) mod patch;
pub(crate) use patch::FileStatus;
pub(super) mod recorder;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use vertebrae_harness_core::{HarnessEventPayloadV1, ToolStatus, UpdateSemantics};

use crate::local_chat::LocalChatAnnotationStore;
pub(crate) use recorder::RecorderConfig;
use recorder::{Boundary, Recorder, RecorderEvent, RecorderGate};

struct ActiveRecorder {
    worktree: PathBuf,
    intended_branch: String,
    sender: mpsc::Sender<RecorderEvent>,
    gate: Arc<RecorderGate>,
}

/// The runtime's handle to its current recorder. Clones share the recorder;
/// with none started, forwarded events are discarded.
#[derive(Clone, Default)]
pub(crate) struct RecordingTap {
    active: Arc<Mutex<Option<ActiveRecorder>>>,
}

impl RecordingTap {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ActiveRecorder>> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Forward the recording-relevant part of a projected harness event.
    /// Tools never wait. A terminal event waits at most five seconds for its
    /// capture before the UI may submit another turn.
    pub(crate) async fn forward(
        &self,
        payload: &HarnessEventPayloadV1,
        semantics: UpdateSemantics,
        is_root_stream: bool,
        parent_tool_id: Option<&str>,
        turn_id: Option<&str>,
    ) {
        let (completion, mut completed) = tokio::sync::oneshot::channel();
        let checkpoint = is_root_stream
            && parent_tool_id.is_none()
            && turn_id.is_some()
            && matches!(
                payload,
                HarnessEventPayloadV1::TurnFinished(_) | HarnessEventPayloadV1::RunFinished(_)
            );
        {
            let active = self.lock();
            let event = recorder_event(payload, semantics, is_root_stream, parent_tool_id);
            let event = if is_root_stream && parent_tool_id.is_none() {
                match (&event, turn_id) {
                    (Some(RecorderEvent::TurnEnded), Some(id)) => {
                        Some(RecorderEvent::TurnCheckpoint {
                            turn_id: id.to_owned(),
                            completion: Some(completion),
                        })
                    }
                    (Some(RecorderEvent::TurnStarted), Some(id)) => {
                        Some(RecorderEvent::TurnIdentity { turn_id: id.into() })
                    }
                    _ => event,
                }
            } else {
                event
            };
            let Some(recorder) = active.as_ref() else {
                if matches!(event, Some(RecorderEvent::Started { .. })) {
                    log::info!("[WORKTREE_DELTA] tool start seen but no recorder is active");
                }
                return;
            };
            let Some(event) = event else {
                return;
            };
            if let RecorderEvent::TurnCheckpoint { turn_id, .. } = &event {
                if !recorder.gate.accept_terminal(turn_id) {
                    return;
                }
            }
            let start = matches!(event, RecorderEvent::Started { .. });
            if start {
                recorder.gate.start_queued();
            }
            let sent = recorder.sender.try_send(event);
            if start && sent.is_err() {
                recorder.gate.start_dequeued();
            }
            if let Err(mpsc::error::TrySendError::Full(_)) = sent {
                if recorder.gate.mark_overflow() {
                    log::warn!(
                        "[WORKTREE_DELTA] recorder for {} is behind; dropping the open segment",
                        recorder.worktree.display()
                    );
                }
            }
        }
        if checkpoint {
            // If the recorder is unhealthy, finish the turn rather than hang
            // chat. The closed receipt prevents it publishing a late state.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), &mut completed).await;
        }
    }

    /// Start recording into `worktree`, replacing any current recorder.
    pub(crate) fn start(
        &self,
        chat_session_id: String,
        worktree: PathBuf,
        intended_branch: Option<String>,
        store: LocalChatAnnotationStore,
        config: RecorderConfig,
    ) {
        let Some(intended_branch) = intended_branch else {
            self.stop();
            return;
        };
        let (sender, receiver) = mpsc::channel(config.channel_capacity.max(1));
        let gate = Arc::new(RecorderGate::new());
        let recorder = Recorder {
            chat_session_id,
            worktree: worktree.clone(),
            intended_branch: intended_branch.clone(),
            store,
            config,
            gate: gate.clone(),
        };
        let previous = self.lock().replace(ActiveRecorder {
            worktree,
            intended_branch,
            sender,
            gate,
        });
        if let Some(previous) = previous {
            previous.gate.deactivate();
        }
        tokio::spawn(recorder.run(receiver));
    }

    /// Stop recording. Open windows are dropped and results that are still
    /// being computed are discarded.
    pub(crate) fn stop(&self) {
        let previous = self.lock().take();
        if let Some(previous) = previous {
            previous.gate.deactivate();
        }
    }

    #[cfg(test)]
    pub(crate) fn worktree(&self) -> Option<PathBuf> {
        self.lock()
            .as_ref()
            .map(|recorder| recorder.worktree.clone())
    }

    pub(crate) fn targets(&self, worktree: &Path, intended_branch: Option<&str>) -> bool {
        self.lock().as_ref().is_some_and(|recorder| {
            recorder.worktree == worktree
                && Some(recorder.intended_branch.as_str()) == intended_branch
        })
    }
}

/// Root-stream tool boundaries open and close windows; any other tool or
/// turn activity on a child stream marks the spawning window as aggregate.
fn recorder_event(
    payload: &HarnessEventPayloadV1,
    semantics: UpdateSemantics,
    is_root_stream: bool,
    parent_tool_id: Option<&str>,
) -> Option<RecorderEvent> {
    if !is_root_stream || parent_tool_id.is_some() {
        let child_activity = match payload {
            HarnessEventPayloadV1::Text(_) => semantics != UpdateSemantics::Delta,
            HarnessEventPayloadV1::TurnStarted(_)
            | HarnessEventPayloadV1::ToolCall(_)
            | HarnessEventPayloadV1::ToolOutput(_)
            | HarnessEventPayloadV1::FileChange(_) => true,
            _ => false,
        };
        return child_activity.then(|| RecorderEvent::Child {
            parent_tool_id: parent_tool_id.map(str::to_owned),
        });
    }
    match payload {
        HarnessEventPayloadV1::ToolCall(call) => Some(RecorderEvent::Started {
            tool_id: call.tool_call_id.to_string(),
            boundary: Boundary::ToolCall,
        }),
        HarnessEventPayloadV1::ToolOutput(output) => Some(RecorderEvent::Finished {
            tool_id: output.tool_call_id.to_string(),
            boundary: Boundary::ToolCall,
        }),
        HarnessEventPayloadV1::FileChange(change) => {
            let tool_id = change.tool_call_id.as_ref()?.to_string();
            let boundary = Boundary::FileChange;
            Some(match change.status {
                ToolStatus::Started | ToolStatus::Running => {
                    RecorderEvent::Started { tool_id, boundary }
                }
                ToolStatus::Completed
                | ToolStatus::Failed
                | ToolStatus::Declined
                | ToolStatus::Cancelled => RecorderEvent::Finished { tool_id, boundary },
            })
        }
        HarnessEventPayloadV1::TurnStarted(_) => Some(RecorderEvent::TurnStarted),
        HarnessEventPayloadV1::TurnFinished(_) | HarnessEventPayloadV1::RunFinished(_) => {
            Some(RecorderEvent::TurnEnded)
        }
        _ => None,
    }
}

/// Canonical project root followed by the canonical roots of its
/// `git worktree list` entries.
pub(crate) fn project_worktree_roots(project_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];

    // Legacy project roots may be subdirectories; preserve that discovery
    // contract while exact worktree consumers use git::repository.
    if let Ok(discovered) = git2::Repository::discover(project_root)
        .map_err(git::GitError::from)
        .and_then(|repo| git::worktree_roots(&repo))
    {
        for path in discovered {
            if let Ok(path) = fs::canonicalize(path) {
                if path.is_dir() && !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
    }

    roots
}

/// Canonical recording target, accepted only when it is the session's
/// project root or one of that project's Git worktrees.
pub(crate) fn resolve_recording_worktree(
    project_root: Option<&str>,
    worktree: &str,
) -> Result<PathBuf, String> {
    let project_root = project_root.ok_or("the session has no project root")?;
    let root = fs::canonicalize(project_root)
        .map_err(|error| format!("could not resolve project root {project_root}: {error}"))?;
    let target = fs::canonicalize(worktree)
        .map_err(|error| format!("could not resolve worktree {worktree}: {error}"))?;
    if project_worktree_roots(&root).contains(&target) {
        Ok(target)
    } else {
        Err(format!(
            "{} is not the project root or one of its Git worktrees",
            target.display()
        ))
    }
}

#[cfg(test)]
mod tests;
