use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::helpers::{build_augmented_path, find_claude_binary, find_codex_binary};
use crate::local_chat::LocalChatHarnessKind;

const CLAUDE_TITLE_MODEL: &str = "haiku";
const CODEX_TITLE_MODEL: &str = "gpt-5.4-mini";
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct InferLocalChatSessionTitleInput {
    pub harness: LocalChatHarnessKind,
    pub initial_prompts: Vec<String>,
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct InferLocalChatSessionTitleOutput {
    pub title: Option<String>,
    pub confidence: f64,
    pub sufficient_signal: bool,
}

pub async fn infer_session_title(
    input: InferLocalChatSessionTitleInput,
) -> Result<InferLocalChatSessionTitleOutput, String> {
    let prompts = input
        .initial_prompts
        .iter()
        .map(|prompt| prompt.trim())
        .filter(|prompt| !prompt.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if prompts.is_empty() {
        return Err("Cannot infer a local chat title from empty prompts.".to_string());
    }

    match input.harness {
        LocalChatHarnessKind::Claude => infer_with_claude(&prompts, input.working_dir).await,
        LocalChatHarnessKind::Codex => infer_with_codex(&prompts, input.working_dir).await,
    }
}

fn title_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": {
                "type": ["string", "null"],
                "maxLength": 60,
                "description": "A concise title for the chat session, or null when the messages do not contain enough signal."
            },
            "confidence": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "Confidence from 0 to 1 that this title is specific and useful."
            },
            "sufficient_signal": {
                "type": "boolean",
                "description": "True only when the provided user messages are specific enough to name the session."
            }
        },
        "required": ["title", "confidence", "sufficient_signal"]
    })
}

fn title_prompt(initial_prompts: &[String]) -> String {
    let messages = initial_prompts
        .iter()
        .enumerate()
        .map(|(index, prompt)| format!("{}. {}", index + 1, prompt))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Create a concise title for a local coding chat session from the user's early messages.\n\
Return only structured output matching the schema.\n\
Rules:\n\
- Use 3 to 7 words when possible.\n\
- Prefer concrete nouns and verbs from the request.\n\
- Do not include quotation marks, trailing punctuation, markdown, or labels.\n\
- If the messages are only greetings, acknowledgements, or vague setup, set title to null, sufficient_signal to false, and confidence below 0.3.\n\
- Set sufficient_signal to true only when the title would help distinguish this session from other local coding chats.\n\
- Use confidence above 0.72 only for specific, actionable session titles.\n\n\
User messages:\n{messages}"
    )
}

fn claude_title_args(schema: &str, prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        prompt.to_string(),
        "--model".to_string(),
        CLAUDE_TITLE_MODEL.to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--json-schema".to_string(),
        schema.to_string(),
        "--no-session-persistence".to_string(),
    ]
}

async fn infer_with_claude(
    initial_prompts: &[String],
    working_dir: Option<String>,
) -> Result<InferLocalChatSessionTitleOutput, String> {
    let binary = find_claude_binary()?;
    let schema = title_schema().to_string();
    let prompt = title_prompt(initial_prompts);
    let mut command = Command::new(binary);
    command.env("PATH", build_augmented_path());
    command
        .args(claude_title_args(&schema, &prompt))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(working_dir) = working_dir.filter(|path| !path.trim().is_empty()) {
        command.current_dir(working_dir);
    }

    let output = tokio::time::timeout(TITLE_TIMEOUT, command.output())
        .await
        .map_err(|_| "Claude title inference timed out.".to_string())?
        .map_err(|err| format!("Failed to run Claude title inference: {err}"))?;
    parse_title_command_output(
        "Claude",
        output.status.success(),
        &output.stdout,
        &output.stderr,
    )
}

async fn infer_with_codex(
    initial_prompts: &[String],
    working_dir: Option<String>,
) -> Result<InferLocalChatSessionTitleOutput, String> {
    let binary = find_codex_binary()?;
    let schema_path = temp_json_path("vertebrae-local-chat-title-schema");
    let output_path = temp_json_path("vertebrae-local-chat-title-output");
    tokio::fs::write(&schema_path, title_schema().to_string())
        .await
        .map_err(|err| format!("Failed to write Codex title schema: {err}"))?;

    let mut command = Command::new(binary);
    command
        .arg("exec")
        .arg("--model")
        .arg(CODEX_TITLE_MODEL)
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("--output-last-message")
        .arg(&output_path)
        .arg("--ephemeral")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--skip-git-repo-check")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(working_dir) = working_dir.filter(|path| !path.trim().is_empty()) {
        command.current_dir(working_dir);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to run Codex title inference: {err}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(title_prompt(initial_prompts).as_bytes())
            .await
            .map_err(|err| format!("Failed to send Codex title prompt: {err}"))?;
    }

    let output = tokio::time::timeout(TITLE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "Codex title inference timed out.".to_string())?
        .map_err(|err| format!("Failed to wait for Codex title inference: {err}"))?;
    let output_file = tokio::fs::read(&output_path).await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&schema_path).await;
    let _ = tokio::fs::remove_file(&output_path).await;

    if output.status.success() {
        if let Ok(candidate) = parse_title_from_bytes(&output_file) {
            return Ok(candidate);
        }
    }
    parse_title_command_output(
        "Codex",
        output.status.success(),
        &output.stdout,
        &output.stderr,
    )
}

fn temp_json_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{}-{}.json", prefix, uuid::Uuid::new_v4()))
}

fn parse_title_command_output(
    provider: &str,
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<InferLocalChatSessionTitleOutput, String> {
    if success {
        return parse_title_from_bytes(stdout);
    }

    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "{provider} title inference failed{}",
        if detail.is_empty() {
            ".".to_string()
        } else {
            format!(": {detail}")
        }
    ))
}

fn parse_title_from_bytes(bytes: &[u8]) -> Result<InferLocalChatSessionTitleOutput, String> {
    let text = String::from_utf8_lossy(bytes);
    parse_title_from_text(text.trim())
}

fn parse_title_from_text(text: &str) -> Result<InferLocalChatSessionTitleOutput, String> {
    if text.is_empty() {
        return Err("Title inference returned no output.".to_string());
    }

    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if let Some(values) = value.as_array() {
            // Claude can emit a JSON array containing system/control records
            // alongside the actual result. Only title-bearing records are
            // candidates; walk from the end to prefer the final user-facing
            // response and ignore control messages.
            for candidate in values.iter().rev() {
                if let Ok(title) = title_from_value(candidate) {
                    return Ok(title);
                }
            }
        }
        match title_from_value(&value) {
            Ok(title) => return Ok(title),
            Err(error) if is_structured_title_envelope(&value) => return Err(error),
            Err(_) => {}
        }
        if let Some(title) = value.as_str().and_then(sanitize_title) {
            return Ok(confident_title(title));
        }
    }

    for line in text
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            match title_from_value(&value) {
                Ok(title) => return Ok(title),
                Err(error) if is_structured_title_envelope(&value) => return Err(error),
                Err(_) => {}
            }
            if let Some(title) = value.as_str().and_then(sanitize_title) {
                return Ok(confident_title(title));
            }
        }
    }

    sanitize_title(text)
        .map(confident_title)
        .ok_or_else(|| "Title inference did not include a usable title.".to_string())
}

fn title_from_value(value: &Value) -> Result<InferLocalChatSessionTitleOutput, String> {
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(format!(
            "Title inference command returned an error: {}",
            title_error_detail(value)
        ));
    }

    if value.get("title").is_some() {
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .and_then(sanitize_title);
        let confidence = value
            .get("confidence")
            .and_then(Value::as_f64)
            .map(clamp_confidence)
            .unwrap_or(if title.is_some() { 1.0 } else { 0.0 });
        let sufficient_signal = value
            .get("sufficient_signal")
            .and_then(Value::as_bool)
            .unwrap_or(title.is_some());
        return Ok(InferLocalChatSessionTitleOutput {
            title,
            confidence,
            sufficient_signal,
        });
    }

    if let Some(structured_output) = value.get("structured_output") {
        return title_from_value(structured_output);
    }

    if let Some(result) = value.get("result") {
        if result.get("title").is_some() {
            return title_from_value(result);
        }
        if let Some(text) = result.as_str() {
            if let Ok(nested) = serde_json::from_str::<Value>(text) {
                return title_from_value(&nested);
            }
            return sanitize_title(text)
                .map(confident_title)
                .ok_or_else(|| "Structured title output was empty.".to_string());
        }
    }

    Err("Structured title output did not include `title`.".to_string())
}

fn is_structured_title_envelope(value: &Value) -> bool {
    value.get("title").is_some()
        || value.get("result").is_some()
        || value.get("structured_output").is_some()
        || value.get("is_error").is_some()
}

fn title_error_detail(value: &Value) -> String {
    if let Some(result) = value.get("result").and_then(Value::as_str) {
        let result = result.trim();
        if !result.is_empty() {
            return result.to_string();
        }
    }

    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        let details = errors
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        if !details.is_empty() {
            return details;
        }
    }

    value
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("unknown provider error")
        .to_string()
}

fn confident_title(title: String) -> InferLocalChatSessionTitleOutput {
    InferLocalChatSessionTitleOutput {
        title: Some(title),
        confidence: 1.0,
        sufficient_signal: true,
    }
}

fn clamp_confidence(confidence: f64) -> f64 {
    confidence.clamp(0.0, 1.0)
}

fn sanitize_title(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`'))
        .trim()
        .trim_end_matches(['.', ':'])
        .trim();
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(60).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_claude_title_command_with_prompt_flag_and_no_tool_flags() {
        let schema = title_schema().to_string();
        let prompt = "Create a concise title.";
        let args = claude_title_args(&schema, prompt);

        assert_eq!(args[0], "-p");
        assert_eq!(args[1], prompt);
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&CLAUDE_TITLE_MODEL.to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"json".to_string()));
        assert!(args.contains(&"--json-schema".to_string()));
        assert!(args.contains(&schema));
        assert!(args.contains(&"--no-session-persistence".to_string()));
        assert!(!args.contains(&"--allowedTools".to_string()));
        assert!(!args.contains(&"--allowed-tools".to_string()));
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn parses_direct_structured_title() {
        assert_eq!(
            parse_title_from_text(
                r#"{"title":"Fix Local Chat Titles","confidence":0.84,"sufficient_signal":true}"#
            )
            .unwrap(),
            InferLocalChatSessionTitleOutput {
                title: Some("Fix Local Chat Titles".to_string()),
                confidence: 0.84,
                sufficient_signal: true,
            }
        );
    }

    #[test]
    fn parses_claude_json_result_string() {
        assert_eq!(
            parse_title_from_text(
                r#"{"result":"{\"title\":\"Local Chat Naming\",\"confidence\":0.91,\"sufficient_signal\":true}"}"#
            )
            .unwrap(),
            InferLocalChatSessionTitleOutput {
                title: Some("Local Chat Naming".to_string()),
                confidence: 0.91,
                sufficient_signal: true,
            }
        );
    }

    #[test]
    fn parses_claude_structured_output() {
        assert_eq!(
            parse_title_from_text(
                r#"{"type":"result","is_error":false,"structured_output":{"title":"Claude Title Inference","confidence":0.88,"sufficient_signal":true}}"#
            )
            .unwrap(),
            InferLocalChatSessionTitleOutput {
                title: Some("Claude Title Inference".to_string()),
                confidence: 0.88,
                sufficient_signal: true,
            }
        );
    }

    #[test]
    fn parses_claude_result_from_array_with_control_records() {
        assert_eq!(
            parse_title_from_text(
                r#"[{"type":"system","subtype":"init"},{"type":"control_request","request_id":"abc"},{"type":"result","is_error":false,"structured_output":{"title":"Fix Claude Session Names","confidence":0.93,"sufficient_signal":true}}]"#
            )
            .unwrap(),
            InferLocalChatSessionTitleOutput {
                title: Some("Fix Claude Session Names".to_string()),
                confidence: 0.93,
                sufficient_signal: true,
            }
        );
    }

    #[test]
    fn rejects_provider_error_wrappers() {
        assert_eq!(
            parse_title_from_text(
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in. Please run /login"}"#
            )
            .unwrap_err(),
            "Title inference command returned an error: Not logged in. Please run /login"
        );
    }

    #[test]
    fn parses_insufficient_signal_output() {
        assert_eq!(
            parse_title_from_text(r#"{"title":null,"confidence":0.12,"sufficient_signal":false}"#)
                .unwrap(),
            InferLocalChatSessionTitleOutput {
                title: None,
                confidence: 0.12,
                sufficient_signal: false,
            }
        );
    }

    #[test]
    fn sanitizes_plain_text_fallback() {
        assert_eq!(
            parse_title_from_text("  \"Implement session title inference.\"  ").unwrap(),
            InferLocalChatSessionTitleOutput {
                title: Some("Implement session title inference".to_string()),
                confidence: 1.0,
                sufficient_signal: true,
            }
        );
    }
}
