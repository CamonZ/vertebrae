use serde_json::{Map, Value};
use vertebrae_harness_core::{
    ControlDecision, ControlResolution, DiagnosticEvent, HarnessEventDraftV1,
    HarnessEventPayloadV1, PlanEntry, PlanEvent, ProviderResumeId, ResolutionSource, SessionId,
    SessionStarted, StreamId, TextEvent, ThreadDeclared, ThreadId, ThreadKind, ToolCallId,
    TurnInput, TurnInputProvenance, UpdateSemantics,
};

use super::{ClaudeDecodeError, ClaudeStreamDecoder};
use super::{claude_init_tools, decode_control_request, rate_limit_failure_message, string};

impl ClaudeStreamDecoder {
    pub(super) fn decode_canonical_value(
        &mut self,
        value: Value,
        provider_sequence: u64,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        self.provider_sequence = provider_sequence;
        let object = value.as_object().expect("validated Claude record object");
        let record_type = string(object, "type").expect("validated Claude record type");
        let parent_tool_call = string(object, "parent_tool_use_id").map(ToolCallId::new);
        let agent_id = string(object, "agent_id")
            .or_else(|| string(object, "agentId"))
            .map(str::to_owned);
        let (thread_id, stream_id, declaration) =
            self.resolve_thread(object, agent_id.as_deref(), parent_tool_call.as_ref());
        let mut drafts = Vec::new();
        if let Some(declaration) = declaration {
            let spawn = declaration
                .caused_by_tool_call_id
                .clone()
                .and_then(|id| self.spawn_tools.get(&id).cloned());
            drafts.push(self.draft(
                stream_id.clone(),
                &thread_id,
                parent_tool_call.clone(),
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::ThreadDeclared(declaration),
            ));
            if let Some(prompt) = spawn.and_then(|spawn| spawn.prompt) {
                drafts.push(self.draft(
                    stream_id.clone(),
                    &thread_id,
                    parent_tool_call.clone(),
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id: thread_id.clone(),
                        run_id: self.context.run_id.clone(),
                        content: prompt,
                        provenance: TurnInputProvenance::Agent,
                    }),
                ));
            }
        }

        match record_type {
            "system" if string(object, "subtype") == Some("init") => {
                let conversation_id = string(object, "session_id")
                    .or_else(|| string(object, "uuid"))
                    .unwrap_or(self.context.root_thread_id.as_str())
                    .to_owned();
                let session_id = SessionId::new(conversation_id.clone());
                self.context.session_id = Some(session_id.clone());
                self.context.root_thread_id = ThreadId::new(conversation_id.clone());
                self.context.provider_resume_id = Some(ProviderResumeId::new(conversation_id));
                self.root_declared = true;
                let root = self.context.root_thread_id.clone();
                let root_stream = self.context.root_stream_id.clone();
                drafts.push(self.draft(
                    root_stream.clone(),
                    &root,
                    None,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::SessionStarted(SessionStarted {
                        provider: "anthropic".into(),
                        model: string(object, "model").map(str::to_owned),
                        provider_resume_id: self.context.provider_resume_id.clone(),
                        tools: claude_init_tools(object),
                    }),
                ));
                if self.declared_threads.insert(root.clone()) {
                    drafts.push(self.draft(
                        root_stream,
                        &root,
                        None,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                            thread_id: root.clone(),
                            parent_thread_id: None,
                            kind: ThreadKind::Root,
                            caused_by_tool_call_id: None,
                            provider_thread_ref: self.root_locator.clone(),
                            agent_metadata: None,
                        }),
                    ));
                }
            }
            "stream_event" => {
                let event = object
                    .get("event")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "stream_event has no nested event object".into(),
                        )
                    })?;
                self.decode_stream_event(
                    event,
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                )?;
            }
            "content_block_delta" => {
                self.decode_delta(
                    object.get("delta").and_then(Value::as_object),
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                )?;
            }
            "assistant" => self.decode_message(
                object,
                true,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
            "user" => self.decode_message(
                object,
                false,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
            "result" => self.decode_result(
                object,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            ),
            "control_request" => {
                let control = decode_control_request(object, &self.context)?;
                if let Some(input) = object
                    .get("request")
                    .and_then(Value::as_object)
                    .and_then(|request| request.get("input"))
                    .cloned()
                {
                    self.provider_control_inputs
                        .insert(control.request_id.clone(), input);
                }
                drafts.push(self.draft(
                    stream_id,
                    &thread_id,
                    parent_tool_call,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::ControlRequested(control),
                ));
            }
            "control_cancel_request" => {
                let request_id = string(object, "request_id").ok_or_else(|| {
                    ClaudeDecodeError::Malformed("control_cancel_request has no request_id".into())
                })?;
                let request_id = super::ControlRequestId::new(request_id);
                self.provider_control_inputs.remove(&request_id);
                drafts.push(self.draft(
                    stream_id,
                    &thread_id,
                    parent_tool_call,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::ControlResolved(ControlResolution {
                        request_id,
                        source: ResolutionSource::Provider,
                        decision: Some(ControlDecision::Cancel),
                        message: Some("Claude cancelled the control request".into()),
                    }),
                ));
            }
            "system" if string(object, "subtype") == Some("task_progress") => {
                if let Some(description) = string(object, "description") {
                    drafts.push(self.draft(
                        stream_id,
                        &thread_id,
                        parent_tool_call,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::Plan(PlanEvent {
                            entries: vec![PlanEntry {
                                id: string(object, "task_id").unwrap_or("task").into(),
                                text: description.into(),
                                status: string(object, "status").map(str::to_owned),
                            }],
                        }),
                    ));
                }
            }
            // Claude emits several system telemetry/status records during a
            // normal turn. They are provider protocol, not user-facing
            // diagnostics; only the explicitly modeled init/task progress
            // records above produce normalized events.
            "system" => {}
            "rate_limit_event" => {
                if let Some(message) = rate_limit_failure_message(object) {
                    drafts.push(self.draft(
                        stream_id,
                        &thread_id,
                        parent_tool_call,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::Error(DiagnosticEvent {
                            message,
                            code: Some("claude_rate_limited".into()),
                        }),
                    ));
                }
            }
            "content_block_start" | "content_block_stop" | "message_start" | "message_stop" => {}
            unknown => drafts.push(self.draft(
                stream_id,
                &thread_id,
                parent_tool_call,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!("ignored unknown Claude stream-json record type: {unknown}"),
                    code: Some("claude_unknown_record".into()),
                }),
            )),
        }
        Ok(drafts)
    }

    pub(super) fn decode_stream_event(
        &self,
        event: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        match string(event, "type") {
            Some("content_block_delta") => self.decode_delta(
                event.get("delta").and_then(Value::as_object),
                thread_id,
                stream_id,
                parent,
                drafts,
            )?,
            Some("message_delta") => {
                if let Some(usage) = event.get("usage") {
                    let usage = usage.as_object().ok_or_else(|| {
                        ClaudeDecodeError::Malformed("message_delta usage is not an object".into())
                    })?;
                    drafts.push(self.usage_draft(stream_id.clone(), thread_id, parent, usage));
                }
            }
            Some(
                "message_start"
                | "message_stop"
                | "content_block_start"
                | "content_block_stop"
                | "ping",
            ) => {}
            Some("error") => {
                let message = event
                    .get("error")
                    .and_then(Value::as_object)
                    .and_then(|error| string(error, "message"))
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "nested error event has no error message".into(),
                        )
                    })?;
                drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Error(DiagnosticEvent {
                        message: message.into(),
                        code: Some("claude_stream_error".into()),
                    }),
                ));
            }
            Some(unknown) => drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!("ignored unknown Claude nested stream event type: {unknown}"),
                    code: Some("claude_unknown_stream_event".into()),
                }),
            )),
            None => {
                return Err(ClaudeDecodeError::Malformed(
                    "nested stream event has no string type".into(),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn decode_delta(
        &self,
        delta: Option<&Map<String, Value>>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let delta = delta.ok_or_else(|| {
            ClaudeDecodeError::Malformed("content_block_delta has no delta object".into())
        })?;
        let payload = match string(delta, "type") {
            Some("thinking_delta") => {
                let text = string(delta, "thinking").ok_or_else(|| {
                    ClaudeDecodeError::Malformed("thinking_delta has no thinking text".into())
                })?;
                HarnessEventPayloadV1::Reasoning(vertebrae_harness_core::ReasoningEvent {
                    text: text.into(),
                })
            }
            Some("text_delta") => {
                let text = string(delta, "text")
                    .ok_or_else(|| ClaudeDecodeError::Malformed("text_delta has no text".into()))?;
                HarnessEventPayloadV1::Text(TextEvent { text: text.into() })
            }
            // Claude streams tool arguments as partial JSON before emitting
            // the completed assistant tool_use snapshot. The fragments are
            // transport protocol and have no standalone neutral event.
            Some("input_json_delta" | "signature_delta") => return Ok(()),
            Some(unknown) => {
                drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Warning(DiagnosticEvent {
                        message: format!("ignored unknown Claude content delta type: {unknown}"),
                        code: Some("claude_unknown_content_delta".into()),
                    }),
                ));
                return Ok(());
            }
            None => {
                return Err(ClaudeDecodeError::Malformed(
                    "content delta has no string type".into(),
                ));
            }
        };
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent,
            UpdateSemantics::Delta,
            payload,
        ));
        Ok(())
    }
}
