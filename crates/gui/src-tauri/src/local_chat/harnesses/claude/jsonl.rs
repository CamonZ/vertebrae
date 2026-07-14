//! Claude CLI stream-json / JSONL parsing.

#![allow(dead_code)] // Some Claude wire fields are parsed for shape compatibility.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::BufRead;

const DEFAULT_CONTEXT_WINDOW: u32 = 200_000;

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    #[serde(rename = "type")]
    msg_type: String,
    subtype: Option<String>,
    uuid: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    tools: Option<Vec<String>>,
    message: Option<ClaudeMessageContent>,
    // Present on sub-agent (sidechain) messages spawned by a Task tool call.
    // Those runs have their own independent context, so their usage must not
    // drive the main conversation's context-utilization meter.
    parent_tool_use_id: Option<String>,
    // Result fields
    duration_ms: Option<u32>,
    num_turns: Option<u32>,
    total_cost_usd: Option<f64>,
    result: Option<String>,
    is_error: Option<bool>,
    // Usage fields from result message
    #[serde(rename = "modelUsage")]
    model_usage: Option<HashMap<String, ModelUsageStats>>,
    // Streaming fields (for direct content_block_delta)
    index: Option<u32>,
    content_block: Option<ContentBlock>,
    delta: Option<ContentDelta>,
    // Nested event for stream_event wrapper
    event: Option<StreamEvent>,
}

/// Usage statistics per model from the result message.
///
/// Only `contextWindow` is retained: the token counts here are cumulative
/// session totals (summed across every internal iteration), so they cannot
/// represent a point-in-time context size. See [`model_usage_context_window`].
#[derive(Debug, Deserialize)]
struct ModelUsageStats {
    #[serde(rename = "contextWindow")]
    context_window: Option<u32>,
}

fn model_usage_context_window(usage: &HashMap<String, ModelUsageStats>) -> u32 {
    // Session-end `modelUsage` is a CUMULATIVE summary: its cache counters are
    // summed across every internal iteration (including sub-agents), so they
    // routinely exceed the context window and cannot represent a point-in-time
    // context size. The per-turn Usage events (message_start/assistant/
    // message_delta) are the source of truth for the meter. Here we only
    // surface the model's context window - the one field that is meaningful.
    usage
        .values()
        .filter_map(|stats| stats.context_window)
        .max()
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// Nested event structure inside stream_event messages.
#[derive(Debug, Deserialize)]
struct StreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    index: Option<u32>,
    delta: Option<ContentDelta>,
    content_block: Option<ContentBlock>,
    usage: Option<AssistantUsage>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ContentDelta {
    #[serde(rename = "type")]
    delta_type: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessageContent {
    role: Option<String>,
    content: Option<Vec<ClaudeContentItem>>,
    model: Option<String>,
    usage: Option<AssistantUsage>,
}

/// Per-turn usage info attached to the assistant `message` field.
/// Mirrors the Anthropic API usage shape inside Claude CLI stream-json output.
#[derive(Debug, Deserialize)]
struct AssistantUsage {
    input_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
    output_tokens: Option<u32>,
}

impl AssistantUsage {
    fn input_context_tokens(&self) -> u32 {
        input_context_tokens(
            self.input_tokens,
            self.cache_read_input_tokens,
            self.cache_creation_input_tokens,
        )
    }
}

fn input_context_tokens(
    input_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
) -> u32 {
    input_tokens
        .unwrap_or(0)
        .saturating_add(cache_read_input_tokens.unwrap_or(0))
        .saturating_add(cache_creation_input_tokens.unwrap_or(0))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClaudeContentItem {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: serde_json::Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

/// A parsed event ready for emission - separates event construction from Tauri dispatch.
#[derive(Debug, Clone)]
pub(crate) enum EmittedEvent {
    Init(InitEvent),
    Text(TextEvent),
    ToolCall(ToolCallEvent),
    ToolResult(ToolResultEvent),
    Usage(UsageEvent),
    SessionEnd(SessionEndEvent),
}

#[derive(Debug, Clone)]
pub(crate) struct InitEvent {
    pub(crate) session_id: String,
    pub(crate) claude_conversation_id: Option<String>,
    pub(crate) model: String,
    pub(crate) tools: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TextEvent {
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) is_partial: bool,
    pub(crate) parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolCallEvent {
    pub(crate) session_id: String,
    pub(crate) tool_id: String,
    pub(crate) tool_name: String,
    pub(crate) input: String,
    pub(crate) parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolResultEvent {
    pub(crate) session_id: String,
    pub(crate) tool_id: String,
    pub(crate) result: String,
    pub(crate) is_error: bool,
    pub(crate) parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct UsageEvent {
    pub(crate) session_id: String,
    pub(crate) model: String,
    pub(crate) context_tokens: u32,
    pub(crate) context_window: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionEndEvent {
    pub(crate) session_id: String,
    pub(crate) duration_ms: u32,
    pub(crate) cost_usd: f64,
    pub(crate) num_turns: u32,
    pub(crate) result: String,
    pub(crate) is_error: bool,
    pub(crate) context_tokens: u32,
    pub(crate) context_window: u32,
}

/// Process JSONL lines from the Claude CLI stdout.
/// Parses each non-empty line as a `ClaudeMessage`, builds events, and passes
/// them to the callback. Stops on read error.
pub(crate) fn process_jsonl_lines(
    mut reader: impl BufRead,
    session_id: &str,
    mut on_events: impl FnMut(Vec<EmittedEvent>),
) {
    let mut line_bytes = Vec::new();
    loop {
        line_bytes.clear();

        match reader.read_until(b'\n', &mut line_bytes) {
            Ok(0) => break,
            Ok(_) => {
                let decoded = String::from_utf8_lossy(&line_bytes);
                let repaired_invalid_utf8 = matches!(decoded, std::borrow::Cow::Owned(_));
                let line = decoded.strip_suffix('\n').unwrap_or(decoded.as_ref());
                let line = line.strip_suffix('\r').unwrap_or(line);

                if line.is_empty() {
                    continue;
                }

                if repaired_invalid_utf8 {
                    log::warn!(
                        "[Claude JSONL] Repaired invalid UTF-8 in stdout line for session={}",
                        &session_id[..8.min(session_id.len())]
                    );
                }

                log::debug!(
                    "[Claude JSONL] session={} msg={}",
                    &session_id[..8.min(session_id.len())],
                    line
                );

                if let Ok(msg) = serde_json::from_str::<ClaudeMessage>(line) {
                    let events = build_events(session_id, msg);
                    if !events.is_empty() {
                        on_events(events);
                    }
                } else {
                    log::warn!("[Claude JSONL] Failed to parse: {}", line);
                }
            }
            Err(e) => {
                log::error!("Error reading stdout: {}", e);
                break;
            }
        }
    }
}

/// Build events from a parsed Claude message without emitting them.
/// This separates pure event construction from Tauri dispatch for testability.
fn build_events(session_id: &str, msg: ClaudeMessage) -> Vec<EmittedEvent> {
    let mut events = Vec::new();

    // Sub-agent (sidechain) messages carry their own context lineage; their
    // usage must not overwrite the main conversation's context meter, and
    // their tool calls/results nest under the spawning Task tool in the UI.
    let parent_tool_use_id = msg.parent_tool_use_id.clone();
    let is_sidechain = parent_tool_use_id.is_some();

    match msg.msg_type.as_str() {
        "system" if msg.subtype.as_deref() == Some("init") => {
            events.push(EmittedEvent::Init(InitEvent {
                session_id: session_id.to_string(),
                // Try session_id first, fall back to uuid
                claude_conversation_id: msg.session_id.or(msg.uuid),
                model: msg.model.unwrap_or_default(),
                tools: msg.tools.unwrap_or_default(),
            }));
        }
        // Streaming: stream_event wraps content_block_delta and other streaming events
        "stream_event" => {
            if let Some(event) = msg.event {
                if event.event_type == "content_block_delta" {
                    if let Some(delta) = event.delta {
                        if delta.delta_type.as_deref() == Some("text_delta") {
                            if let Some(text) = delta.text {
                                events.push(EmittedEvent::Text(TextEvent {
                                    session_id: session_id.to_string(),
                                    text,
                                    is_partial: true,
                                    parent_tool_use_id: parent_tool_use_id.clone(),
                                }));
                            }
                        }
                    }
                } else if event.event_type == "message_delta" && !is_sidechain {
                    if let Some(usage) = event.usage {
                        let context_tokens = usage.input_context_tokens();
                        events.push(EmittedEvent::Usage(UsageEvent {
                            session_id: session_id.to_string(),
                            model: msg.model.clone().unwrap_or_default(),
                            context_tokens,
                            context_window: DEFAULT_CONTEXT_WINDOW,
                        }));
                    }
                }
            }
        }
        // Streaming: content_block_delta contains incremental text (direct, non-wrapped)
        "content_block_delta" => {
            if let Some(delta) = msg.delta {
                if delta.delta_type.as_deref() == Some("text_delta") {
                    if let Some(text) = delta.text {
                        events.push(EmittedEvent::Text(TextEvent {
                            session_id: session_id.to_string(),
                            text,
                            is_partial: true,
                            parent_tool_use_id: parent_tool_use_id.clone(),
                        }));
                    }
                }
            }
        }
        // Streaming: content_block_start indicates a new block
        "content_block_start" => {
            // We could emit a "start typing" indicator here.
            // For now, we just wait for the deltas.
        }
        // Streaming: content_block_stop indicates block is complete
        "content_block_stop" => {
            // Could emit a "done typing" indicator here.
        }
        "assistant" => {
            if let Some(message) = msg.message {
                // Emit a per-turn usage event so the UI badge updates
                // mid-conversation, not only at session_end. Skip sidechain
                // (sub-agent) turns: their context is independent of the
                // main conversation and would make the meter lurch.
                if let Some(usage) = message.usage.as_ref().filter(|_| !is_sidechain) {
                    let context_tokens = usage.input_context_tokens();
                    events.push(EmittedEvent::Usage(UsageEvent {
                        session_id: session_id.to_string(),
                        model: message.model.clone().unwrap_or_default(),
                        context_tokens,
                        // Backend has no per-turn context_window; fall back to the
                        // default context window. The frontend uses its own
                        // model->max lookup table as the source of truth for
                        // the displayed max.
                        context_window: DEFAULT_CONTEXT_WINDOW,
                    }));
                }
                if let Some(content) = message.content {
                    for item in content {
                        match item {
                            ClaudeContentItem::Text { text } => {
                                events.push(EmittedEvent::Text(TextEvent {
                                    session_id: session_id.to_string(),
                                    text,
                                    is_partial: false,
                                    parent_tool_use_id: parent_tool_use_id.clone(),
                                }));
                            }
                            ClaudeContentItem::ToolUse { id, name, input } => {
                                // AskUserQuestion is transported authoritatively by vtb-gate's
                                // permission socket because that path carries the request id
                                // needed to answer it. Rendering this stream-json copy would
                                // create a duplicate, non-actionable tool row.
                                if name == crate::local_chat::permissions::ASK_USER_QUESTION_TOOL {
                                    continue;
                                }
                                events.push(EmittedEvent::ToolCall(ToolCallEvent {
                                    session_id: session_id.to_string(),
                                    tool_id: id,
                                    tool_name: name,
                                    input: serde_json::to_string(&input).unwrap_or_default(),
                                    parent_tool_use_id: parent_tool_use_id.clone(),
                                }));
                            }
                            ClaudeContentItem::ToolResult { .. } | ClaudeContentItem::Other => {}
                        }
                    }
                }
            }
        }
        "user" => {
            if let Some(message) = msg.message {
                if let Some(content) = message.content {
                    for item in content {
                        if let ClaudeContentItem::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } = item
                        {
                            let result_text = match content {
                                serde_json::Value::String(s) => s,
                                other => serde_json::to_string(&other).unwrap_or_default(),
                            };

                            events.push(EmittedEvent::ToolResult(ToolResultEvent {
                                session_id: session_id.to_string(),
                                tool_id: tool_use_id,
                                result: result_text,
                                is_error,
                                parent_tool_use_id: parent_tool_use_id.clone(),
                            }));
                        }
                    }
                }
            }
        }
        "result" => {
            // `modelUsage` is a cumulative session summary, not a
            // point-in-time context size, so it cannot drive the meter.
            // The per-turn Usage events own `context_tokens`; here we only
            // carry the model's context window.
            let context_window = msg
                .model_usage
                .as_ref()
                .map(model_usage_context_window)
                .unwrap_or(DEFAULT_CONTEXT_WINDOW);
            let context_tokens = 0;

            events.push(EmittedEvent::SessionEnd(SessionEndEvent {
                session_id: session_id.to_string(),
                duration_ms: msg.duration_ms.unwrap_or(0),
                cost_usd: msg.total_cost_usd.unwrap_or(0.0),
                num_turns: msg.num_turns.unwrap_or(0),
                result: msg.result.unwrap_or_default(),
                is_error: msg.is_error.unwrap_or(false),
                context_tokens,
                context_window,
            }));
        }
        _ => {}
    }

    events
}

#[cfg(test)]
mod tests;
