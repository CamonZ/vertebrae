use chrono::Utc;
use serde_json::{Map, Value};
use vertebrae_harness_core::{
    AgentMetadata, EventCorrelation, HarnessEventDraftV1, HarnessEventPayloadV1, ProviderThreadRef,
    StreamId, ThreadId, ToolCallId, UpdateSemantics,
};

use super::ClaudeStreamDecoder;

impl ClaudeStreamDecoder {
    pub(super) fn draft(
        &self,
        stream_id: StreamId,
        thread_id: &ThreadId,
        parent_tool_call_id: Option<ToolCallId>,
        semantics: UpdateSemantics,
        payload: HarnessEventPayloadV1,
    ) -> HarnessEventDraftV1 {
        HarnessEventDraftV1 {
            stream_id,
            correlation: EventCorrelation {
                session_id: if self.root_declared {
                    self.context.session_id.clone()
                } else {
                    None
                },
                thread_id: self.root_declared.then(|| thread_id.clone()),
                turn_id: self.context.turn_id.clone(),
                run_id: self.context.run_id.clone(),
                parent_tool_call_id,
                provider_resume_id: if self.root_declared {
                    self.context.provider_resume_id.clone()
                } else {
                    None
                },
                ..EventCorrelation::default()
            },
            timestamp: self.event_timestamp.unwrap_or_else(Utc::now),
            semantics,
            provider_sequence: Some(self.provider_sequence),
            payload,
        }
    }
}

pub(super) fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

pub(super) fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, super::ClaudeDecodeError> {
    object
        .get(key)
        .ok_or_else(|| super::ClaudeDecodeError::Malformed(format!("{context} has no {key}")))?
        .as_str()
        .ok_or_else(|| {
            super::ClaudeDecodeError::Malformed(format!("{context} {key} is not a string"))
        })
}

pub(super) fn required_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, super::ClaudeDecodeError> {
    let value = required_string(object, key, context)?;
    if value.trim().is_empty() {
        Err(super::ClaudeDecodeError::Malformed(format!(
            "{context} {key} is empty"
        )))
    } else {
        Ok(value)
    }
}

pub(super) fn optional_bool(
    object: &Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<Option<bool>, super::ClaudeDecodeError> {
    object
        .get(key)
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                super::ClaudeDecodeError::Malformed(format!("{context} {key} is not a boolean"))
            })
        })
        .transpose()
}

pub(super) fn provider_thread_ref(object: &Map<String, Value>) -> Option<ProviderThreadRef> {
    ["provider_thread_ref", "transcript_path", "transcriptPath"]
        .iter()
        .find_map(|key| string(object, key))
        .map(ProviderThreadRef::new)
}

pub(super) fn agent_metadata(object: &Map<String, Value>) -> AgentMetadata {
    AgentMetadata {
        name: string(object, "agent_name").map(str::to_owned),
        role: string(object, "agent_role").map(str::to_owned),
        model: string(object, "model").map(str::to_owned),
    }
}

pub(super) fn is_spawn_tool(name: &str) -> bool {
    matches!(name, "Task" | "Agent" | "TaskCreate")
}

pub(super) fn claude_init_tools(object: &Map<String, Value>) -> Vec<String> {
    object
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            tool.as_str()
                .or_else(|| tool.get("name").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .collect()
}

pub(super) enum RateLimitClassification {
    Advisory(String),
    Fatal(String),
}

pub(super) fn classify_rate_limit_event(
    object: &Map<String, Value>,
) -> Option<RateLimitClassification> {
    let info = object.get("rate_limit_info").and_then(Value::as_object);
    let status = info
        .and_then(|info| string(info, "status"))
        .or_else(|| string(object, "status"));
    let message = string(object, "message")
        .or_else(|| string(object, "reason"))
        .or_else(|| {
            object
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| string(error, "message"))
        })
        .or_else(|| info.and_then(|info| string(info, "message")));
    let message_is_rate_limit = message.is_some_and(|message| {
        let message = message.to_ascii_lowercase();
        message.contains("rate limit")
            || message.contains("rate_limit")
            || message.contains("too many requests")
    });
    let status = status.map(str::to_ascii_lowercase);
    let status_is_allowed = status
        .as_deref()
        .is_some_and(|status| matches!(status, "allowed" | "ok" | "available" | "active"));
    if !message_is_rate_limit && (status.is_none() || status_is_allowed) {
        return None;
    }
    let is_advisory = status.as_deref() == Some("allowed_warning");
    let message = message
        .map(str::to_owned)
        .or_else(|| {
            status
                .as_deref()
                .map(|status| format!("Claude rate limit status: {status}"))
        })
        .unwrap_or_else(|| "Claude rate limit reached".into());
    Some(if is_advisory {
        RateLimitClassification::Advisory(message)
    } else {
        RateLimitClassification::Fatal(message)
    })
}
