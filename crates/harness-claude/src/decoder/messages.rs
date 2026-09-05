use serde_json::{Map, Value};
use vertebrae_harness_core::{
    AgentMetadata, CompletionStatus, FileChange, FileChangeEvent, FileChangeKind,
    HarnessEventDraftV1, HarnessEventPayloadV1, PlanEntry, PlanEvent, StreamId, TextEvent,
    ThreadId, ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus, UpdateSemantics,
};

use super::drafts::{is_spawn_tool, optional_bool, required_nonempty_string, required_string};
use super::{ClaudeDecodeError, ClaudeStreamDecoder, SpawnInfo};

impl ClaudeStreamDecoder {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn decode_message(
        &mut self,
        record: &Map<String, Value>,
        assistant: bool,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let message = record
            .get("message")
            .ok_or_else(|| ClaudeDecodeError::Malformed("message record has no message".into()))?
            .as_object()
            .ok_or_else(|| {
                ClaudeDecodeError::Malformed("message record message is not an object".into())
            })?;
        if assistant && let Some(usage) = message.get("usage") {
            let usage = usage.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed("assistant message usage is not an object".into())
            })?;
            drafts.push(self.usage_draft(stream_id.clone(), thread_id, parent.clone(), usage));
        }
        let content = message
            .get("content")
            .ok_or_else(|| ClaudeDecodeError::Malformed("message has no content".into()))?;
        let Some(content) = content.as_array() else {
            // Claude echoes slash commands, local command output, and compact
            // summaries as user records whose message content is a string.
            // Those records are provider protocol, not neutral live events;
            // only array content can contain tool results that we need to
            // project for the user stream.
            if !assistant && content.is_string() {
                return Ok(());
            }
            return Err(ClaudeDecodeError::Malformed(
                "message content is not an array".into(),
            ));
        };
        for (index, item) in content.iter().enumerate() {
            let item = item.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed(format!(
                    "message content block {} is not an object",
                    index + 1
                ))
            })?;
            let block_type = required_nonempty_string(item, "type", "message content block")?;
            match block_type {
                "text" => {
                    let text = required_string(item, "text", "text content block")?;
                    if assistant {
                        let mut draft = self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::Text(TextEvent {
                                text: text.into(),
                                completion_status: Some(CompletionStatus::Completed),
                            }),
                        );
                        draft.correlation.item_id = self.current_item_id.as_ref().map(|id| {
                            vertebrae_harness_core::ItemId::new(format!("{id}:block:{index}"))
                        });
                        drafts.push(draft);
                    }
                }
                "thinking" => {
                    let text = required_string(item, "thinking", "thinking content block")?;
                    if assistant {
                        drafts.push(self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::Reasoning(
                                vertebrae_harness_core::ReasoningEvent { text: text.into() },
                            ),
                        ));
                    }
                }
                "tool_use" | "server_tool_use" => {
                    let id = required_nonempty_string(item, "id", "tool_use content block")?;
                    let name = required_nonempty_string(item, "name", "tool_use content block")?;
                    let input = item.get("input").cloned().ok_or_else(|| {
                        ClaudeDecodeError::Malformed("tool_use content block has no input".into())
                    })?;
                    if assistant {
                        if let Some(changes) = claude_file_changes(name, &input) {
                            let tool_call_id = ToolCallId::new(id);
                            self.pending_file_changes
                                .insert(tool_call_id.clone(), changes.clone());
                            drafts.push(self.draft(
                                stream_id.clone(),
                                thread_id,
                                parent.clone(),
                                UpdateSemantics::Snapshot,
                                HarnessEventPayloadV1::FileChange(FileChangeEvent {
                                    tool_call_id: Some(tool_call_id),
                                    changes,
                                    status: ToolStatus::Started,
                                }),
                            ));
                        }
                        self.decode_tool_use(
                            id,
                            name,
                            input,
                            thread_id,
                            stream_id,
                            parent.clone(),
                            drafts,
                        )?;
                    }
                }
                "tool_result"
                | "web_search_tool_result"
                | "web_fetch_tool_result"
                | "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result"
                | "tool_search_tool_result" => {
                    let id =
                        required_nonempty_string(item, "tool_use_id", "tool_result content block")?;
                    let output = item.get("content").cloned().ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "tool_result content block has no content".into(),
                        )
                    })?;
                    let failed = optional_bool(item, "is_error", "tool_result content block")?
                        .unwrap_or(false);
                    if !assistant {
                        let tool_call_id = ToolCallId::new(id);
                        if let Some(changes) = self.pending_file_changes.remove(&tool_call_id) {
                            drafts.push(self.draft(
                                stream_id.clone(),
                                thread_id,
                                parent.clone(),
                                UpdateSemantics::Snapshot,
                                HarnessEventPayloadV1::FileChange(FileChangeEvent {
                                    tool_call_id: Some(tool_call_id.clone()),
                                    changes,
                                    status: if failed {
                                        ToolStatus::Failed
                                    } else {
                                        ToolStatus::Completed
                                    },
                                }),
                            ));
                        }
                        drafts.push(self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                                tool_call_id: ToolCallId::new(id),
                                output,
                                status: if failed {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Completed
                                },
                                content_semantics: UpdateSemantics::Snapshot,
                            }),
                        ));
                    }
                }
                // Opaque or non-text user content is valid but has no neutral
                // live event in this adapter. Validate its stable outer shape
                // and ignore it deliberately rather than treating it as new.
                "redacted_thinking" => {
                    required_string(item, "data", "redacted_thinking content block")?;
                }
                "image" | "document" => {
                    item.get("source")
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            ClaudeDecodeError::Malformed(format!(
                                "{block_type} content block has no source object"
                            ))
                        })?;
                }
                unknown => drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent.clone(),
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Warning(vertebrae_harness_core::DiagnosticEvent {
                        message: format!(
                            "ignored unknown Claude message content block type: {unknown}"
                        ),
                        code: Some("claude_unknown_content_block".into()),
                    }),
                )),
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn decode_tool_use(
        &mut self,
        id: &str,
        name: &str,
        input: Value,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let tool_call_id = ToolCallId::new(id);
        if is_spawn_tool(name) {
            self.spawn_tools.insert(
                tool_call_id.clone(),
                SpawnInfo {
                    parent_thread_id: thread_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    prompt: input
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    metadata: AgentMetadata {
                        name: input
                            .get("name")
                            .or_else(|| input.get("subagent_type"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        role: input
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        model: input
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                },
            );
        }
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent.clone(),
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                tool_call_id: tool_call_id.clone(),
                name: name.into(),
                input: input.clone(),
                status: ToolStatus::Started,
            }),
        ));
        if name == "TodoWrite"
            && let Some(todos) = input.get("todos")
        {
            let todos = todos.as_array().ok_or_else(|| {
                ClaudeDecodeError::Malformed("TodoWrite todos is not an array".into())
            })?;
            let mut entries = Vec::with_capacity(todos.len());
            for (index, todo) in todos.iter().enumerate() {
                let todo = todo.as_object().ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "TodoWrite item {} is not an object",
                        index + 1
                    ))
                })?;
                let text = todo
                    .get("content")
                    .or_else(|| todo.get("text"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(format!(
                            "TodoWrite item {} has no text",
                            index + 1
                        ))
                    })?;
                entries.push(PlanEntry {
                    id: todo
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| index.to_string()),
                    text: text.into(),
                    status: todo
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Plan(PlanEvent { entries }),
            ));
        }
        Ok(())
    }
}

/// Convert Claude's native file tools into the shared file-change shape.
///
/// Claude reports edits as tool inputs rather than a provider-neutral diff:
/// `Edit`/`MultiEdit` carry replacements and `Write` carries the complete
/// file body. The synthetic unified diff keeps the original operation useful
/// to both the trace and local-chat renderers without making either surface
/// understand Claude's private input schema.
fn claude_file_changes(name: &str, input: &Value) -> Option<Vec<FileChange>> {
    match name {
        "Edit" => {
            let path = string_field(input, &["file_path", "path"])?;
            let old = string_field_allow_empty(input, "old_string")?;
            let new = string_field_allow_empty(input, "new_string")?;
            Some(vec![replacement_change(path, old, new)])
        }
        "Write" => {
            let path = string_field(input, &["file_path", "path"])?;
            let content = string_field_allow_empty(input, "content")?;
            Some(vec![FileChange {
                path: path.to_owned(),
                kind: FileChangeKind::Added,
                previous_path: None,
                patch: Some(unified_replacement("", content)),
            }])
        }
        "MultiEdit" => {
            let path = string_field(input, &["file_path", "path"])?;
            let edits = input.get("edits")?.as_array()?;
            let mut hunks = Vec::new();
            for edit in edits {
                let old = string_field_allow_empty(edit, "old_string")?;
                let new = string_field_allow_empty(edit, "new_string")?;
                hunks.push(unified_replacement(old, new));
            }
            (!hunks.is_empty()).then(|| {
                vec![FileChange {
                    path: path.to_owned(),
                    kind: FileChangeKind::Modified,
                    previous_path: None,
                    patch: Some(hunks.join("\n")),
                }]
            })
        }
        "NotebookEdit" => {
            let path = string_field(input, &["notebook_path", "file_path", "path"])?;
            let new_source = string_field_allow_empty(input, "new_source")?;
            Some(vec![FileChange {
                path: path.to_owned(),
                kind: FileChangeKind::Modified,
                previous_path: None,
                patch: Some(unified_replacement("", new_source)),
            }])
        }
        _ => None,
    }
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

fn string_field_allow_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn replacement_change(path: &str, old: &str, new: &str) -> FileChange {
    FileChange {
        path: path.to_owned(),
        kind: FileChangeKind::Modified,
        previous_path: None,
        patch: Some(unified_replacement(old, new)),
    }
}

fn unified_replacement(old: &str, new: &str) -> String {
    let mut lines = vec!["@@".to_owned()];
    lines.extend(old.lines().map(|line| format!("-{line}")));
    lines.extend(new.lines().map(|line| format!("+{line}")));
    if old.is_empty() && new.is_empty() {
        lines.push("+".to_owned());
    }
    lines.join("\n")
}
