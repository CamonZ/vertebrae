use serde_json::{Map, Value};
use vertebrae_harness_core::{
    CompactionEvent, CompactionState, ControlDecision, ControlResolution, DiagnosticEvent,
    HarnessEventDraftV1, HarnessEventPayloadV1, PlanEntry, PlanEvent, ProviderResumeId,
    ResolutionSource, SessionId, SessionStarted, SpeedTier, SpeedTierStatus, StreamId, TextEvent,
    ThreadDeclared, ThreadId, ThreadKind, ToolCallId, ToolOutputEvent, ToolStatus, TurnInput,
    TurnInputProvenance, UpdateSemantics,
};

use super::controls::decode_control_request;
use super::drafts::{
    RateLimitClassification, classify_rate_limit_event, claude_init_tools,
    required_nonempty_string, string,
};
use super::{ClaudeDecodeError, ClaudeStreamDecoder};

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
                let model = string(object, "model").map(str::to_owned);
                let speed_tier_status = self.speed_tier_status(object, model.as_deref());
                self.fast_mode_state = string(object, "fast_mode_state").map(str::to_owned);
                drafts.push(self.draft(
                    root_stream.clone(),
                    &root,
                    None,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::SessionStarted(SessionStarted {
                        provider: "anthropic".into(),
                        model,
                        provider_resume_id: self.context.provider_resume_id.clone(),
                        speed_tier_status: speed_tier_status.clone(),
                        tools: claude_init_tools(object),
                    }),
                ));
                if let Some(diagnostic) = speed_tier_status.and_then(|status| status.diagnostic) {
                    drafts.push(self.draft(
                        root_stream.clone(),
                        &root,
                        None,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::Warning(DiagnosticEvent {
                            message: diagnostic,
                            code: Some("claude_fast_mode".into()),
                        }),
                    ));
                }
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
            "assistant" => {
                self.decode_fast_mode_state(object, &thread_id, &stream_id, &mut drafts);
                self.decode_message(
                    object,
                    true,
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                )?;
            }
            "user" => self.decode_message(
                object,
                false,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
            "result" => {
                self.decode_fast_mode_state(object, &thread_id, &stream_id, &mut drafts);
                self.decode_result(
                    object,
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                );
            }
            "tool_progress" => self.decode_tool_progress(
                object,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
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
            "system" if string(object, "subtype") == Some("status") => {
                self.decode_compaction_status(
                    object,
                    &stream_id,
                    &thread_id,
                    parent_tool_call,
                    &mut drafts,
                );
            }
            "system" if string(object, "subtype") == Some("compact_boundary") => {
                if !self.compaction_boundary_emitted {
                    let compact_metadata =
                        object.get("compact_metadata").and_then(Value::as_object);
                    drafts.push(
                        self.draft(
                            stream_id,
                            &thread_id,
                            parent_tool_call,
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::Compaction(CompactionEvent {
                                state: CompactionState::Completed,
                                trigger: compact_metadata
                                    .and_then(|metadata| string(metadata, "trigger"))
                                    .map(str::to_owned),
                                pre_tokens: compact_metadata
                                    .and_then(|metadata| metadata.get("pre_tokens"))
                                    .and_then(Value::as_u64),
                            }),
                        ),
                    );
                    self.compaction_active = false;
                    self.compaction_boundary_emitted = true;
                }
            }
            // Claude emits several system telemetry/status records during a
            // normal turn. They are provider protocol, not user-facing
            // diagnostics; only the explicitly modeled init/task progress
            // records above produce normalized events.
            "system" => {}
            "rate_limit_event" => {
                if let Some(classification) = classify_rate_limit_event(object) {
                    let payload = match classification {
                        RateLimitClassification::Advisory(message) => {
                            HarnessEventPayloadV1::Warning(DiagnosticEvent {
                                message,
                                code: Some("claude_rate_limit_warning".into()),
                            })
                        }
                        RateLimitClassification::Fatal(message) => {
                            HarnessEventPayloadV1::Error(DiagnosticEvent {
                                message,
                                code: Some("claude_rate_limited".into()),
                            })
                        }
                    };
                    drafts.push(self.draft(
                        stream_id,
                        &thread_id,
                        parent_tool_call,
                        UpdateSemantics::Snapshot,
                        payload,
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

    fn speed_tier_status(
        &self,
        object: &Map<String, Value>,
        model: Option<&str>,
    ) -> Option<SpeedTierStatus> {
        let requested = self.context.requested_speed_tier;
        let state = string(object, "fast_mode_state");
        if requested.is_none() && state.is_none() {
            return None;
        }
        let model_is_eligible = model.is_some_and(|model| model.contains("opus-4-6"));
        let eligible = requested != Some(SpeedTier::Fast)
            || model_is_eligible
            || matches!(state, Some("on" | "cooldown"));
        let (active, available, diagnostic) = match state {
            Some("on") => (Some(SpeedTier::Fast), eligible, None),
            Some("cooldown") => (
                Some(SpeedTier::Default),
                false,
                Some(
                    "Claude fast mode fell back to standard mode while its rate limit cools down."
                        .into(),
                ),
            ),
            Some("off") => {
                let diagnostic = (requested == Some(SpeedTier::Fast)).then(|| {
                    if !eligible {
                        "Claude fast mode is not eligible for the selected model.".into()
                    } else {
                        "Claude fast mode is unavailable for this account or organization.".into()
                    }
                });
                (
                    Some(SpeedTier::Default),
                    requested != Some(SpeedTier::Fast),
                    diagnostic,
                )
            }
            Some(_) => (
                None,
                false,
                Some("Claude reported an unknown fast-mode state.".into()),
            ),
            None if requested == Some(SpeedTier::Fast) => (
                None,
                false,
                Some("Claude did not report fast-mode availability.".into()),
            ),
            None => (Some(SpeedTier::Default), true, None),
        };
        Some(SpeedTierStatus {
            requested,
            active,
            eligible,
            available,
            diagnostic,
        })
    }

    fn decode_fast_mode_state(
        &mut self,
        object: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) {
        let state = string(object, "fast_mode_state").map(str::to_owned);
        if state == self.fast_mode_state {
            return;
        }
        self.fast_mode_state = state.clone();
        if state.as_deref() == Some("cooldown")
            && self.context.requested_speed_tier == Some(SpeedTier::Fast)
        {
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                None,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: "Claude fast mode fell back to standard mode while its rate limit cools down.".into(),
                    code: Some("claude_fast_mode_fallback".into()),
                }),
            ));
        }
    }

    fn decode_compaction_status(
        &mut self,
        object: &Map<String, Value>,
        stream_id: &StreamId,
        thread_id: &ThreadId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) {
        if string(object, "status") == Some("compacting") {
            if self.compaction_active {
                return;
            }
            self.compaction_active = true;
            self.compaction_boundary_emitted = false;
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Compaction(CompactionEvent {
                    state: CompactionState::Active,
                    trigger: None,
                    pre_tokens: None,
                }),
            ));
        } else if self.compaction_active {
            self.compaction_active = false;
            self.compaction_boundary_emitted = false;
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Compaction(CompactionEvent {
                    state: CompactionState::Cleared,
                    trigger: None,
                    pre_tokens: None,
                }),
            ));
        }
    }

    fn decode_tool_progress(
        &self,
        object: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let tool_call_id = required_nonempty_string(object, "tool_use_id", "tool_progress")?;
        let tool_name = required_nonempty_string(object, "tool_name", "tool_progress")?;
        let elapsed_seconds = object
            .get("elapsed_time_seconds")
            .cloned()
            .filter(|value| {
                value
                    .as_f64()
                    .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0)
            })
            .ok_or_else(|| {
                ClaudeDecodeError::Malformed(
                    "tool_progress elapsed_time_seconds is not a non-negative number".into(),
                )
            })?;
        let task_id = match object.get("task_id") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let task_id = value.as_str().ok_or_else(|| {
                    ClaudeDecodeError::Malformed("tool_progress task_id is not a string".into())
                })?;
                Some(task_id)
            }
        };

        // The V1 contract already represents an in-flight tool update as a
        // running ToolOutput delta. Keep the output object provider-neutral;
        // Claude's elapsed_time_seconds wire name does not escape the adapter.
        let mut progress = Map::new();
        progress.insert("kind".into(), Value::String("progress".into()));
        progress.insert("tool_name".into(), Value::String(tool_name.into()));
        progress.insert("elapsed_seconds".into(), elapsed_seconds);
        if let Some(task_id) = task_id {
            progress.insert("task_id".into(), Value::String(task_id.into()));
        }

        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent,
            UpdateSemantics::Delta,
            HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                tool_call_id: ToolCallId::new(tool_call_id),
                output: Value::Object(progress),
                status: ToolStatus::Running,
                content_semantics: UpdateSemantics::Delta,
            }),
        ));
        Ok(())
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
