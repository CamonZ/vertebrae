use chrono::Utc;
use serde_json::{Value, json};

const RAW_TRAFFIC_ENV: &str = "VERTEBRAE_CODEX_RAW_TRAFFIC";

pub(crate) fn raw_traffic_logging_enabled() -> bool {
    matches!(
        std::env::var(RAW_TRAFFIC_ENV).as_deref(),
        Ok("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

pub(crate) fn trace(
    session_id: Option<&str>,
    kind: &str,
    direction: &str,
    turn_id: Option<&str>,
    state: &str,
    detail: Option<&str>,
    payload: Option<&str>,
) {
    let record = json!({
        "timestamp_ms": Utc::now().timestamp_millis(),
        "source": "codex",
        "kind": kind,
        "direction": direction,
        "session_id": session_id,
        "turn_id": turn_id,
        "state": state,
        "detail": detail,
        "payload": payload,
    });
    log::info!("[LOCAL_CHAT_TRACE] {record}");
}

/// Thread config carries the custom provider's bearer token and the tool
/// environment, so both are masked before a frame reaches any log.
fn redact_wire_payload(payload: &str) -> std::borrow::Cow<'_, str> {
    if !payload.contains("experimental_bearer_token")
        && !payload.contains("shell_environment_policy")
    {
        return payload.into();
    }
    let Ok(mut frame) = serde_json::from_str::<Value>(payload) else {
        return "<unparseable frame withheld: may carry credentials>".into();
    };
    if let Some(config) = frame.pointer_mut("/params/config") {
        if let Some(providers) = config
            .get_mut("model_providers")
            .and_then(Value::as_object_mut)
        {
            for provider in providers.values_mut() {
                if let Some(token) = provider.get_mut("experimental_bearer_token") {
                    *token = json!("<redacted>");
                }
            }
        }
        if let Some(set) = config
            .pointer_mut("/shell_environment_policy/set")
            .and_then(Value::as_object_mut)
        {
            for value in set.values_mut() {
                *value = json!("<redacted>");
            }
        }
    }
    frame.to_string().into()
}

pub(crate) fn log_raw_traffic(direction: &str, payload: &str) {
    let payload = redact_wire_payload(payload);
    let payload = payload.as_ref();
    let (kind, trace_direction) = match direction {
        "send" => ("wire.send", "harness_to_provider"),
        "recv" => ("wire.recv", "provider_to_harness"),
        _ => ("wire", "internal"),
    };
    trace(
        None,
        kind,
        trace_direction,
        None,
        "transport",
        None,
        Some(payload),
    );
    if raw_traffic_logging_enabled() {
        log::info!("[Codex][raw][{direction}] {payload}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_provider_token_and_tool_environment_from_thread_frames() {
        let frame = json!({"id": 3, "method": "thread/start", "params": {"cwd": "/w", "config": {
            "model_providers": {"p": {"name": "p", "experimental_bearer_token": "sk-secret"}},
            "shell_environment_policy": {"inherit": "all", "set": {"PATH": "/bin", "FOO": "bar"}},
            "model_verbosity": "low"}}})
        .to_string();

        let redacted = redact_wire_payload(&frame);

        assert!(!redacted.contains("sk-secret") && !redacted.contains("/bin"));
        assert!(redacted.contains("<redacted>") && redacted.contains("model_verbosity"));
        let plain = r#"{"id":1,"method":"initialize","params":{}}"#;
        assert_eq!(redact_wire_payload(plain), plain);
        assert!(!redact_wire_payload("experimental_bearer_token sk-x {").contains("sk-x"));
    }
}
