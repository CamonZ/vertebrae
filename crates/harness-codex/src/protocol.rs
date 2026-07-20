use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRpcMessage {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<CodexRpcError>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexNotification {
    AgentMessageDelta(Value),
    ItemStarted(Value),
    ItemCompleted(Value),
    ThreadStarted(Value),
    ThreadStatusChanged(Value),
    TokenUsageUpdated(Value),
    TurnCompleted(Value),
    Error(Value),
    Unknown { method: String, params: Value },
}

impl CodexNotification {
    pub fn method(&self) -> &str {
        match self {
            Self::AgentMessageDelta(_) => "item/agentMessage/delta",
            Self::ItemStarted(_) => "item/started",
            Self::ItemCompleted(_) => "item/completed",
            Self::ThreadStarted(_) => "thread/started",
            Self::ThreadStatusChanged(_) => "thread/status/changed",
            Self::TokenUsageUpdated(_) => "thread/tokenUsage/updated",
            Self::TurnCompleted(_) => "turn/completed",
            Self::Error(_) => "error",
            Self::Unknown { method, .. } => method,
        }
    }

    pub fn params(&self) -> &Value {
        match self {
            Self::AgentMessageDelta(value)
            | Self::ItemStarted(value)
            | Self::ItemCompleted(value)
            | Self::ThreadStarted(value)
            | Self::ThreadStatusChanged(value)
            | Self::TokenUsageUpdated(value)
            | Self::TurnCompleted(value)
            | Self::Error(value) => value,
            Self::Unknown { params, .. } => params,
        }
    }
}

/// Decode known App Server notifications at the protocol boundary. Known
/// notifications must carry an object, while unknown optional notifications
/// remain observable instead of being silently discarded.
pub fn decode_notification(
    method: impl Into<String>,
    params: Value,
) -> Result<CodexNotification, String> {
    let method = method.into();
    let known = match method.as_str() {
        "item/agentMessage/delta" => CodexNotification::AgentMessageDelta(params),
        "item/started" => CodexNotification::ItemStarted(params),
        "item/completed" => CodexNotification::ItemCompleted(params),
        "thread/started" => CodexNotification::ThreadStarted(params),
        "thread/status/changed" => CodexNotification::ThreadStatusChanged(params),
        "thread/tokenUsage/updated" => CodexNotification::TokenUsageUpdated(params),
        "turn/completed" => CodexNotification::TurnCompleted(params),
        "error" => CodexNotification::Error(params),
        _ => return Ok(CodexNotification::Unknown { method, params }),
    };
    if !known.params().is_object() {
        return Err(format!(
            "Codex notification {} requires object params",
            known.method()
        ));
    }
    Ok(known)
}

pub(crate) fn required_string(
    value: &Value,
    pointers: &[&str],
    field: &str,
) -> Result<String, String> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Codex {field} is missing or not a string"))
}

pub(crate) fn optional_string(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub(crate) fn number(value: &Value, pointers: &[&str]) -> Option<u64> {
    pointers.iter().find_map(|pointer| {
        value.pointer(pointer).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_f64().map(|value| value.max(0.0) as u64))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_notifications_are_preserved() {
        let notification =
            decode_notification("thread/future", serde_json::json!({"value": 1})).unwrap();
        assert!(
            matches!(notification, CodexNotification::Unknown { method, .. } if method == "thread/future")
        );
    }

    #[test]
    fn malformed_known_notifications_are_rejected_at_the_boundary() {
        let error = decode_notification("item/agentMessage/delta", Value::Null).unwrap_err();
        assert!(error.contains("requires object params"));
    }
}
