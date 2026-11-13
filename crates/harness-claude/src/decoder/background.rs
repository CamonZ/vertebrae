//! Claude Code `system` records `task_started`, `task_progress`,
//! `task_updated`, `task_notification` and `background_tasks_changed`, as
//! defined by the SDK schema in Claude Code 2.1.322.
//!
//! The `tool_result` of the launching `Bash` call only acknowledges the
//! launch, so outcomes come from `task_updated` and `task_notification`.
//! Agent tasks are not background work; their threads are declared through
//! lineage and shown with the other subagents.

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{Map, Value};
use vertebrae_harness_core::{
    BackgroundRosterEntry, BackgroundRosterEvent, BackgroundWorkEvent, BackgroundWorkId,
    BackgroundWorkKind, BackgroundWorkStatus, HarnessEventDraftV1, HarnessEventPayloadV1, StreamId,
    ThreadId, ToolCallId, UpdateSemantics,
};

use super::ClaudeStreamDecoder;
use super::drafts::string;

#[derive(Debug, Clone)]
pub(super) struct TaskTrack {
    generation: u32,
    terminal: bool,
    /// `None` for agent tasks, which are not reported.
    kind: Option<BackgroundWorkKind>,
    provider_kind: Option<String>,
}

fn kind_for(task_type: Option<&str>, subagent_type: Option<&str>) -> Option<BackgroundWorkKind> {
    match task_type {
        Some("local_bash" | "monitor") => Some(BackgroundWorkKind::Command),
        Some("local_agent" | "remote_agent" | "in_process_teammate") => None,
        None if subagent_type.is_some() => None,
        _ => Some(BackgroundWorkKind::Other),
    }
}

pub(super) fn is_background_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "task_started"
            | "task_progress"
            | "task_updated"
            | "task_notification"
            | "background_tasks_changed"
    )
}

fn is_ambient(object: &Map<String, Value>) -> bool {
    object.get("ambient").and_then(Value::as_bool) == Some(true)
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn epoch_millis(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_i64)
        .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
}

impl ClaudeStreamDecoder {
    pub(super) fn decode_background_record(
        &mut self,
        subtype: &str,
        object: &Map<String, Value>,
        stream_id: &StreamId,
        thread_id: &ThreadId,
        parent_tool_call: Option<&ToolCallId>,
    ) -> Option<HarnessEventDraftV1> {
        let payload = match subtype {
            "task_started" => self.task_started(object),
            "task_progress" => self.task_progress(object),
            "task_updated" => self.task_updated(object),
            "task_notification" => self.task_notification(object),
            "background_tasks_changed" => self.background_roster(object),
            _ => None,
        }?;

        Some(self.draft(
            stream_id.clone(),
            thread_id,
            parent_tool_call.cloned(),
            UpdateSemantics::Snapshot,
            payload,
        ))
    }

    fn observed_at(&self) -> DateTime<Utc> {
        self.event_timestamp.unwrap_or_else(Utc::now)
    }

    fn base_event(
        &self,
        task_id: &str,
        track: &TaskTrack,
        status: BackgroundWorkStatus,
        object: &Map<String, Value>,
    ) -> Option<BackgroundWorkEvent> {
        let mut event = BackgroundWorkEvent::new(task_id, track.kind?, status);
        event.generation = track.generation;
        event.provider_kind.clone_from(&track.provider_kind);
        event.launch_tool_call_id = string(object, "tool_use_id").map(ToolCallId::new);

        Some(event)
    }

    fn task_started(&mut self, object: &Map<String, Value>) -> Option<HarnessEventPayloadV1> {
        if is_ambient(object) {
            return None;
        }
        let task_id = string(object, "task_id")?;
        let task_type = string(object, "task_type");
        let kind = kind_for(task_type, string(object, "subagent_type"));

        let track = self
            .background_tasks
            .entry(task_id.to_owned())
            .and_modify(|track| {
                if track.terminal {
                    // Claude resumes a finished task under the same id.
                    track.generation += 1;
                    track.terminal = false;
                }
                if track.kind == Some(BackgroundWorkKind::Other) {
                    track.kind = kind;
                }
                if task_type.is_some() {
                    track.provider_kind = task_type.map(str::to_owned);
                }
            })
            .or_insert_with(|| TaskTrack {
                generation: 0,
                terminal: false,
                kind,
                provider_kind: task_type.map(str::to_owned),
            })
            .clone();

        let mut event = self.base_event(task_id, &track, BackgroundWorkStatus::Running, object)?;
        event.description = nonempty(string(object, "description"));
        // Claude emits this record as it registers the task.
        event.started_at = Some(self.observed_at());

        Some(HarnessEventPayloadV1::BackgroundWork(event))
    }

    fn known_track(&mut self, task_id: &str, object: &Map<String, Value>) -> TaskTrack {
        self.background_tasks
            .entry(task_id.to_owned())
            .or_insert_with(|| TaskTrack {
                generation: 0,
                terminal: false,
                kind: kind_for(None, string(object, "subagent_type")),
                provider_kind: None,
            })
            .clone()
    }

    fn task_progress(&mut self, object: &Map<String, Value>) -> Option<HarnessEventPayloadV1> {
        let task_id = string(object, "task_id")?;
        let track = self.known_track(task_id, object);
        if track.terminal {
            return None;
        }

        let mut event = self.base_event(task_id, &track, BackgroundWorkStatus::Running, object)?;
        event.description = nonempty(string(object, "description"));
        event.progress = nonempty(string(object, "summary"))
            .or_else(|| string(object, "last_tool_name").map(|tool| format!("Last tool: {tool}")));
        event.started_at = object
            .get("usage")
            .and_then(|usage| usage.get("duration_ms"))
            .and_then(Value::as_i64)
            .map(|duration| self.observed_at() - Duration::milliseconds(duration));

        Some(HarnessEventPayloadV1::BackgroundWork(event))
    }

    fn task_updated(&mut self, object: &Map<String, Value>) -> Option<HarnessEventPayloadV1> {
        let task_id = string(object, "task_id")?;
        let patch = object.get("patch").and_then(Value::as_object)?;

        let status = match string(patch, "status") {
            Some("pending" | "running" | "paused") => BackgroundWorkStatus::Running,
            Some("completed") => BackgroundWorkStatus::Completed,
            Some("failed") => BackgroundWorkStatus::Failed,
            Some("killed") => BackgroundWorkStatus::Cancelled,
            Some(_) => BackgroundWorkStatus::Unknown,
            None => return self.task_renamed(task_id, patch, object),
        };

        let track = self.known_track(task_id, object);
        if status.is_terminal() {
            self.mark_terminal(task_id);
        } else if track.terminal {
            return None;
        }

        let mut event = self.base_event(task_id, &track, status, object)?;
        event.description = nonempty(string(patch, "description"));
        if string(patch, "status") == Some("paused") {
            event.progress = Some("Paused".into());
        }
        event.finished_at = epoch_millis(patch.get("end_time"));
        event.error = nonempty(string(patch, "error"));

        Some(HarnessEventPayloadV1::BackgroundWork(event))
    }

    /// A patch without a status only changes the description of running work.
    fn task_renamed(
        &mut self,
        task_id: &str,
        patch: &Map<String, Value>,
        object: &Map<String, Value>,
    ) -> Option<HarnessEventPayloadV1> {
        let track = self.known_track(task_id, object);
        if track.terminal {
            return None;
        }

        let mut event = self.base_event(task_id, &track, BackgroundWorkStatus::Running, object)?;
        event.description = Some(nonempty(string(patch, "description"))?);

        Some(HarnessEventPayloadV1::BackgroundWork(event))
    }

    fn mark_terminal(&mut self, task_id: &str) {
        if let Some(track) = self.background_tasks.get_mut(task_id) {
            track.terminal = true;
        }
    }

    fn task_notification(&mut self, object: &Map<String, Value>) -> Option<HarnessEventPayloadV1> {
        if is_ambient(object) {
            return None;
        }
        let task_id = string(object, "task_id")?;

        let status = match (string(object, "status"), string(object, "reason")) {
            // Claude reports an orphaned task as `stopped`, but nobody stopped it.
            (_, Some("worker_restart")) => BackgroundWorkStatus::Unknown,
            (Some("completed"), _) => BackgroundWorkStatus::Completed,
            (Some("failed"), _) => BackgroundWorkStatus::Failed,
            (Some("stopped"), _) => BackgroundWorkStatus::Cancelled,
            _ => BackgroundWorkStatus::Unknown,
        };

        let track = self.known_track(task_id, object);
        self.mark_terminal(task_id);

        let mut event = self.base_event(task_id, &track, status, object)?;
        event.progress = nonempty(string(object, "summary"));
        event.finished_at = Some(self.observed_at());

        if status == BackgroundWorkStatus::Unknown {
            event.error = Some(match string(object, "reason") {
                Some("worker_restart") => "Claude restarted and found the task orphaned".into(),
                _ => "Claude reported no outcome for the task".into(),
            });
        }

        Some(HarnessEventPayloadV1::BackgroundWork(event))
    }

    fn background_roster(&mut self, object: &Map<String, Value>) -> Option<HarnessEventPayloadV1> {
        let tasks = object.get("tasks").and_then(Value::as_array)?;
        let mut work = Vec::new();

        for task in tasks.iter().filter_map(Value::as_object) {
            if is_ambient(task) {
                continue;
            }
            let Some(task_id) = string(task, "task_id") else {
                continue;
            };

            let task_type = string(task, "task_type");
            let kind = kind_for(task_type, string(task, "subagent_type"));
            let track = self
                .background_tasks
                .entry(task_id.to_owned())
                .or_insert_with(|| TaskTrack {
                    generation: 0,
                    terminal: false,
                    kind,
                    provider_kind: task_type.map(str::to_owned),
                });
            if track.kind == Some(BackgroundWorkKind::Other) {
                track.kind = kind;
            }
            let Some(kind) = track.kind else {
                continue;
            };

            work.push(BackgroundRosterEntry {
                work_id: BackgroundWorkId::new(task_id),
                kind,
                provider_kind: task_type.map(str::to_owned),
                description: nonempty(string(task, "description")),
            });
        }

        Some(HarnessEventPayloadV1::BackgroundRoster(
            BackgroundRosterEvent { work },
        ))
    }
}
