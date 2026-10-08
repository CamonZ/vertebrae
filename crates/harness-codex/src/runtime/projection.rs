use serde_json::{Value, json};
use vertebrae_harness_core::{
    DiagnosticEvent, FileChange, FileChangeEvent, FileChangeKind, HarnessError,
    HarnessEventPayloadV1, ItemId, SessionTitle, TextEvent, ThreadId, ToolCallEvent, ToolCallId,
    ToolOutputEvent, ToolStatus, TurnId, TurnOutcome, UpdateSemantics, UsageEvent,
};

use super::outcome::{TurnAccumulator, outcome_from_completion, parse_usage, usage_delta};
use super::session::SessionState;
use crate::{CodexNotification, optional_string, required_string};

impl SessionState {
    pub(super) async fn process_notification(
        &self,
        notification: CodexNotification,
        expected_provider_turn: Option<&str>,
        normalized_root_turn: Option<&TurnId>,
        root_turn: &mut TurnAccumulator,
    ) -> Result<Option<TurnOutcome>, HarnessError> {
        let params = notification.params().clone();
        let thread_id = optional_string(&params, &["/threadId", "/thread/id"]);
        let is_child = thread_id
            .as_deref()
            .is_some_and(|id| id != self.root_thread_id.as_str());
        let (stream, mut correlation) = if is_child {
            let Some((_, stream, correlation)) = self.declare_child(&params).await? else {
                return Ok(None);
            };
            (stream, correlation)
        } else {
            if let Some(expected) = expected_provider_turn {
                let actual = optional_string(&params, &["/turnId", "/turn/id"]);
                if actual.as_deref().is_some_and(|actual| actual != expected) {
                    log::warn!(
                        "[Codex] dropping {} for mismatched turn_id actual={actual:?} expected={expected}",
                        notification.method()
                    );
                    return Ok(None);
                }
            }
            (
                self.root_stream_id.clone(),
                self.root_correlation(normalized_root_turn.cloned(), None),
            )
        };
        match notification {
            CodexNotification::AgentMessageDelta(params) => {
                correlation.item_id =
                    optional_string(&params, &["/itemId", "/item_id", "/item/id"]).map(ItemId::new);
                let text = required_string(&params, &["/delta"], "agent message delta")
                    .map_err(HarnessError::Operation)?;
                if !is_child {
                    root_turn.text.push_str(&text);
                }
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Text(TextEvent {
                        text,
                        ..Default::default()
                    }),
                    UpdateSemantics::Delta,
                )
                .await?;
            }
            CodexNotification::ItemStarted(params) => {
                let Some(item) = params.get("item") else {
                    return Err(HarnessError::Operation(
                        "Codex item/started is missing item".into(),
                    ));
                };
                let item_id =
                    optional_string(item, &["/id", "/itemId", "/item_id"]).map(ItemId::new);
                correlation.item_id = item_id;
                if let Some(file_change) = file_change_event(item) {
                    correlation.tool_call_id = file_change.tool_call_id.clone();
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::FileChange(file_change),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else if let Some((tool_id, name, input, is_spawn)) = tool_call(item) {
                    correlation.tool_call_id = Some(ToolCallId::new(tool_id.clone()));
                    if is_spawn {
                        let parent_thread = thread_id
                            .as_deref()
                            .map(ThreadId::new)
                            .unwrap_or_else(|| self.root_thread_id.clone());
                        self.remember_spawn(item, &tool_id, parent_thread).await;
                    }
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                            tool_call_id: ToolCallId::new(tool_id),
                            name,
                            input,
                            status: ToolStatus::Started,
                        }),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                }
            }
            CodexNotification::ItemCompleted(params) => {
                let Some(item) = params.get("item") else {
                    return Err(HarnessError::Operation(
                        "Codex item/completed is missing item".into(),
                    ));
                };
                let item_id =
                    optional_string(item, &["/id", "/itemId", "/item_id"]).map(ItemId::new);
                correlation.item_id = item_id;
                if let Some(file_change) = file_change_event(item) {
                    correlation.tool_call_id = file_change.tool_call_id.clone();
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::FileChange(file_change),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else {
                    match item.get("type").and_then(Value::as_str) {
                        Some("agentMessage") => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                if !is_child {
                                    root_turn.text = text.to_string();
                                }
                                self.emit(
                                    stream,
                                    correlation,
                                    HarnessEventPayloadV1::Text(TextEvent {
                                        text: text.into(),
                                        completion_status: Some(
                                            vertebrae_harness_core::CompletionStatus::Completed,
                                        ),
                                    }),
                                    UpdateSemantics::Snapshot,
                                )
                                .await?;
                            }
                        }
                        _ => {
                            if let Some((tool_id, output, failed)) = tool_output(item) {
                                correlation.tool_call_id = Some(ToolCallId::new(tool_id.clone()));
                                self.emit(
                                    stream,
                                    correlation,
                                    HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                                        tool_call_id: ToolCallId::new(tool_id),
                                        output,
                                        status: if failed {
                                            ToolStatus::Failed
                                        } else {
                                            ToolStatus::Completed
                                        },
                                        content_semantics: UpdateSemantics::Snapshot,
                                    }),
                                    UpdateSemantics::Snapshot,
                                )
                                .await?;
                            }
                        }
                    }
                }
            }
            CodexNotification::TokenUsageUpdated(params) => {
                let usage = parse_usage(&params);
                let turn_delta = if !is_child {
                    let turn_delta = usage.0.as_ref().map(|current| {
                        let delta = usage_delta(root_turn.last_usage.as_ref(), current);
                        root_turn.last_usage = Some(current.clone());
                        root_turn.usage = Some(current.clone());
                        delta
                    });
                    root_turn.context_tokens = usage
                        .1
                        .as_ref()
                        .and_then(|snapshot| snapshot.context_tokens);
                    root_turn.context_window = usage
                        .1
                        .as_ref()
                        .and_then(|snapshot| snapshot.context_window);
                    turn_delta
                } else {
                    usage.0.clone()
                };
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Usage(UsageEvent {
                        turn_delta,
                        session_snapshot: usage.1,
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
            CodexNotification::TurnCompleted(params) => {
                let status = optional_string(&params, &["/turn/status", "/status"])
                    .unwrap_or_else(|| "completed".into());
                let actual_turn = optional_string(&params, &["/turnId", "/turn/id"]);
                log::info!(
                    "[Codex] turn/completed received thread_id={thread_id:?} turn_id={actual_turn:?} expected_turn={expected_provider_turn:?} status={status}"
                );
                let outcome = outcome_from_completion(&params, status, root_turn);
                if is_child {
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::TurnFinished(outcome),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else {
                    return Ok(Some(outcome));
                }
            }
            CodexNotification::Error(params) => {
                let message = optional_string(
                    &params,
                    &["/message", "/error/message", "/turn/error/message"],
                )
                .unwrap_or_else(|| params.to_string());
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Error(DiagnosticEvent {
                        message,
                        code: Some("codex_error".into()),
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
            CodexNotification::ThreadStarted(_)
            | CodexNotification::ThreadStatusChanged(_)
            | CodexNotification::ThreadNameUpdated(_)
            | CodexNotification::ThreadUpdated(_) => {
                if !is_child {
                    if let Some(title) =
                        optional_string(&params, &["/threadName", "/thread/name", "/name"])
                            .filter(|title| !title.trim().is_empty())
                    {
                        self.emit(
                            stream,
                            correlation,
                            HarnessEventPayloadV1::SessionTitle(SessionTitle { title }),
                            UpdateSemantics::Snapshot,
                        )
                        .await?;
                    }
                } else {
                    let _ = self.declare_child(&params).await?;
                }
            }
            CodexNotification::Unknown { .. } => {
                // App Server notifications are an extensible provider
                // protocol. Routine lifecycle and capability notifications
                // are not chat content, and surfacing them as warnings makes
                // the local chat transcript provider-version dependent. Keep
                // the unknown value observable at the protocol boundary, but
                // let the provider-neutral stream ignore notifications it does
                // not project into V1 events.
            }
        }
        Ok(None)
    }
}

pub(crate) fn tool_call(item: &Value) -> Option<(String, String, Value, bool)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    if kind == "fileChange" {
        return None;
    }
    let is_tool = kind.contains("tool") || kind == "commandExecution";
    if !is_tool {
        return None;
    }
    let id = optional_string(item, &["/id", "/toolCallId", "/tool_call_id"])?;
    if kind == "commandExecution" {
        let command = optional_string(item, &["/command"])?;
        let mut input = json!({"command": command});
        if let Some(cwd) = optional_string(item, &["/cwd"]) {
            input["cwd"] = json!(cwd);
        }
        return Some((id, "Bash".into(), input, false));
    }
    let name = optional_string(item, &["/tool", "/name", "/type"]).unwrap_or_else(|| kind.into());
    let input = item
        .get("input")
        .cloned()
        .or_else(|| item.get("arguments").cloned())
        .unwrap_or_else(|| json!({"item":item}));
    Some((id, name, input, kind == "collabAgentToolCall"))
}

pub(crate) fn file_change_event(item: &Value) -> Option<FileChangeEvent> {
    if item.get("type").and_then(Value::as_str) != Some("fileChange") {
        return None;
    }
    let tool_call_id = optional_string(item, &["/id", "/itemId", "/toolCallId"])?;
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|change| {
            let path = optional_string(change, &["/path"])?;
            let kind = match optional_string(change, &["/kind", "/type"])?.as_str() {
                "add" | "added" => FileChangeKind::Added,
                "delete" | "deleted" => FileChangeKind::Deleted,
                "rename" | "renamed" => FileChangeKind::Renamed,
                "update" | "updated" | "modify" | "modified" => FileChangeKind::Modified,
                _ => return None,
            };
            Some(FileChange {
                path,
                kind,
                previous_path: optional_string(change, &["/previousPath", "/previous_path"]),
                patch: optional_string(change, &["/diff", "/patch", "/unifiedDiff"]),
            })
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return None;
    }
    let status = match optional_string(item, &["/status"]).as_deref() {
        Some("inProgress") | Some("started") | Some("running") => ToolStatus::Started,
        Some("failed") | Some("error") => ToolStatus::Failed,
        Some("declined") => ToolStatus::Declined,
        Some("cancelled") | Some("canceled") => ToolStatus::Cancelled,
        _ => ToolStatus::Completed,
    };
    Some(FileChangeEvent {
        tool_call_id: Some(ToolCallId::new(tool_call_id)),
        changes,
        status,
    })
}

pub(crate) fn tool_output(item: &Value) -> Option<(String, Value, bool)> {
    let id = optional_string(item, &["/id", "/toolCallId", "/tool_call_id"])?;
    let output = item
        .get("output")
        .cloned()
        .or_else(|| item.get("result").cloned())
        .or_else(|| item.get("aggregatedOutput").cloned())
        .or_else(|| item.get("aggregated_output").cloned())
        .or_else(|| item.get("text").cloned())?;
    let failed = item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "error"))
        || item
            .get("exitCode")
            .or_else(|| item.get("exit_code"))
            .and_then(Value::as_i64)
            .is_some_and(|exit_code| exit_code != 0);
    Some((id, output, failed))
}

pub(crate) fn summary(content: &str) -> Option<String> {
    let mut chars = content.chars();
    let value: String = chars.by_ref().take(160).collect();
    if value.is_empty() {
        None
    } else if chars.next().is_some() {
        Some(format!("{value}…"))
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{SessionState, file_change_event, tool_call, tool_output};
    use serde_json::json;
    use vertebrae_harness_core::{
        FileChangeKind, SessionId, ThreadId, ToolCallId, ToolStatus, TurnId,
    };

    #[test]
    fn child_correlation_preserves_parent_tool_call() {
        let correlation = SessionState::child_correlation(
            &SessionId::new("root-session"),
            ThreadId::new("child-thread"),
            Some(TurnId::new("child-turn")),
            Some(ToolCallId::new("spawn-tool")),
        );

        assert_eq!(
            correlation.parent_tool_call_id,
            Some(ToolCallId::new("spawn-tool"))
        );
    }

    #[test]
    fn maps_command_execution_start_and_completion_to_one_tool_lifecycle() {
        let started = json!({
            "type": "commandExecution",
            "id": "exec-1",
            "command": "/bin/zsh -lc \"pwd\"",
            "cwd": "/repo",
            "status": "inProgress",
        });
        let completed = json!({
            "type": "commandExecution",
            "id": "exec-1",
            "command": "/bin/zsh -lc \"pwd\"",
            "status": "completed",
            "exitCode": 0,
            "aggregatedOutput": "/repo",
        });

        assert_eq!(
            tool_call(&started),
            Some((
                "exec-1".into(),
                "Bash".into(),
                json!({"command":"/bin/zsh -lc \"pwd\"", "cwd":"/repo"}),
                false,
            ))
        );
        assert_eq!(
            tool_output(&completed),
            Some(("exec-1".into(), "/repo".into(), false))
        );
    }

    #[test]
    fn maps_nonzero_command_exit_code_to_failed_tool_output() {
        let completed = json!({
            "type": "commandExecution",
            "id": "exec-2",
            "status": "completed",
            "exitCode": 1,
            "aggregatedOutput": "boom",
        });

        assert_eq!(
            tool_output(&completed),
            Some(("exec-2".into(), "boom".into(), true))
        );
    }

    #[test]
    fn maps_file_change_items_to_structured_lifecycle_events() {
        let started = json!({
            "type": "fileChange",
            "id": "file-1",
            "status": "inProgress",
            "changes": [{"path": "src/new.rs", "kind": "add", "diff": "+fn main() {}"}]
        });
        let completed = json!({
            "type": "fileChange",
            "id": "file-1",
            "status": "completed",
            "changes": [{"path": "src/new.rs", "kind": "add", "diff": "+fn main() {}"}]
        });

        let started = file_change_event(&started).expect("started file change");
        assert_eq!(started.tool_call_id.as_ref().unwrap().as_str(), "file-1");
        assert_eq!(started.status, ToolStatus::Started);
        assert_eq!(started.changes[0].kind, FileChangeKind::Added);

        let completed = file_change_event(&completed).expect("completed file change");
        assert_eq!(completed.status, ToolStatus::Completed);
        assert_eq!(completed.changes[0].path, "src/new.rs");
    }
}
