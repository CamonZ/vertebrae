//! Claude CLI session management with JSONL streaming
//!
//! Provides structured chat interaction with Claude CLI using
//! streaming JSON input/output instead of PTY-based terminal emulation.

#![allow(dead_code)] // Some fields are parsed but not yet used

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::Emitter;
use tauri_specta::Event;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::helpers::find_claude_binary;

/// Build an augmented PATH that prepends commonly needed directories for macOS GUI apps.
///
/// macOS GUI applications inherit a minimal PATH (typically just `/usr/bin:/bin:/usr/sbin:/sbin`)
/// because they don't source shell profiles. This function prepends `~/.cargo/bin`,
/// `/opt/homebrew/bin`, and `/usr/local/bin` so that tools installed via cargo, Homebrew, or
/// manually into `/usr/local/bin` are discoverable by subprocesses.
fn build_augmented_path() -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".cargo/bin").to_string_lossy().into_owned());
    }

    parts.push("/opt/homebrew/bin".to_string());
    parts.push("/usr/local/bin".to_string());

    let current_path = std::env::var("PATH").unwrap_or_default();
    if !current_path.is_empty() {
        parts.push(current_path);
    }

    parts.join(":")
}

/// Truncate a string to at most `max_bytes` bytes without splitting a multi-byte UTF-8 character.
/// Walks backwards from the target offset to find the nearest char boundary.
fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }
    let mut end = max_bytes;
    // is_char_boundary(0) is always true, so this loop always terminates
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ============================================================================
// Events emitted to the frontend
// ============================================================================

/// Event emitted when Claude session initializes
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionInitEvent {
    pub session_id: String,
    /// Claude's conversation ID - use this with --resume for multi-turn
    pub claude_conversation_id: Option<String>,
    pub model: String,
    pub tools: Vec<String>,
}

/// Event emitted when Claude produces text output
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeTextEvent {
    pub session_id: String,
    pub text: String,
    /// Whether this is a partial (streaming) message
    pub is_partial: bool,
}

/// Event emitted when Claude calls a tool
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeToolCallEvent {
    pub session_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub input: String, // JSON string
}

/// Event emitted when a tool returns a result
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeToolResultEvent {
    pub session_id: String,
    pub tool_id: String,
    pub result: String,
    pub is_error: bool,
}

/// Event emitted after each assistant message with the latest context-size figure.
///
/// `context_tokens` is the non-cached input token count for the most recent
/// assistant turn — the source of truth for "how full is the context window".
/// Cache reads, cache creation, and output tokens are cost signals and are
/// intentionally excluded.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionUsageEvent {
    pub session_id: String,
    /// Model name reported by the assistant message
    pub model: String,
    /// Non-cached input tokens for the latest assistant turn
    pub context_tokens: u32,
    /// Backend-reported context window (fallback when frontend lookup misses)
    pub context_window: u32,
}

/// Event emitted when Claude session ends
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionEndEvent {
    pub session_id: String,
    pub duration_ms: u32,
    pub cost_usd: f64,
    pub num_turns: u32,
    pub result: String,
    pub is_error: bool,
    /// Total tokens used in context (input + cache)
    pub context_tokens: u32,
    /// Maximum context window size
    pub context_window: u32,
}

/// Event emitted when Claude session encounters an error
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionErrorEvent {
    pub session_id: String,
    pub error: String,
}

/// Event emitted when Claude requests permission
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudePermissionRequestEvent {
    pub session_id: String,
    pub tool_name: String,
    pub permission_message: String,
}

// ============================================================================
// Internal message types for parsing Claude CLI JSONL output
// ============================================================================

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
    // Result fields
    duration_ms: Option<u32>,
    num_turns: Option<u32>,
    total_cost_usd: Option<f64>,
    result: Option<String>,
    is_error: Option<bool>,
    // Usage fields from result message
    #[serde(rename = "modelUsage")]
    model_usage: Option<std::collections::HashMap<String, ModelUsageStats>>,
    // Streaming fields (for direct content_block_delta)
    index: Option<u32>,
    content_block: Option<ContentBlock>,
    delta: Option<ContentDelta>,
    // Nested event for stream_event wrapper
    event: Option<StreamEvent>,
}

/// Usage statistics per model from the result message
#[derive(Debug, Deserialize)]
struct ModelUsageStats {
    #[serde(rename = "inputTokens")]
    input_tokens: Option<u32>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<u32>,
    #[serde(rename = "cacheReadInputTokens")]
    cache_read_input_tokens: Option<u32>,
    #[serde(rename = "cacheCreationInputTokens")]
    cache_creation_input_tokens: Option<u32>,
    #[serde(rename = "contextWindow")]
    context_window: Option<u32>,
}

/// Nested event structure inside stream_event messages
#[derive(Debug, Deserialize)]
struct StreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    index: Option<u32>,
    delta: Option<ContentDelta>,
    content_block: Option<ContentBlock>,
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
    delta_type: String,
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
}

// ============================================================================
// Parsed event types (for testability)
// ============================================================================

/// A parsed event ready for emission — separates event construction from Tauri dispatch.
#[derive(Debug, Clone)]
enum EmittedEvent {
    Init(ClaudeSessionInitEvent),
    Text(ClaudeTextEvent),
    ToolCall(ClaudeToolCallEvent),
    ToolResult(ClaudeToolResultEvent),
    PermissionRequest(ClaudePermissionRequestEvent),
    Usage(ClaudeSessionUsageEvent),
    SessionEnd(ClaudeSessionEndEvent),
}

// ============================================================================
// Session management
// ============================================================================

/// Commands sent to the Claude session thread
enum SessionCommand {
    SendMessage {
        content: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    Close {
        response: oneshot::Sender<Result<(), String>>,
    },
}

/// Handle to a Claude session
struct SessionHandle {
    command_tx: mpsc::UnboundedSender<SessionCommand>,
}

/// Manages active Claude CLI sessions
pub struct ClaudeSessionManager {
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
}

impl ClaudeSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a new Claude session with JSONL streaming
    /// If `resume_session_id` is provided, continues an existing Claude conversation
    pub async fn create_session(
        &self,
        session_id: String,
        working_dir: Option<String>,
        initial_prompt: Option<String>,
        resume_session_id: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), ClaudeSessionError> {
        // Check if session already exists
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(&session_id) {
                return Err(ClaudeSessionError::SessionExists(session_id));
            }
        }

        // Create command channel
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        // Store session handle
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), SessionHandle { command_tx });
        }

        // Spawn the session thread
        let sessions = self.sessions.clone();
        let session_id_clone = session_id.clone();
        thread::spawn(move || {
            Self::run_session(
                session_id_clone,
                working_dir,
                initial_prompt,
                resume_session_id,
                command_rx,
                app_handle,
                sessions,
            );
        });

        log::info!("Claude session {} created", session_id);
        Ok(())
    }

    /// Run the Claude CLI session in a dedicated thread
    fn run_session(
        session_id: String,
        working_dir: Option<String>,
        initial_prompt: Option<String>,
        resume_session_id: Option<String>,
        mut command_rx: mpsc::UnboundedReceiver<SessionCommand>,
        app_handle: tauri::AppHandle,
        sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
    ) {
        // Find the Claude Code CLI binary using unified discovery logic
        let claude_binary = match find_claude_binary() {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(e) => {
                log::error!("Failed to find Claude Code CLI: {}", e);
                // Notify frontend of initialization failure
                let _ = app_handle.emit(
                    "claude-session-init-event",
                    ClaudeSessionInitEvent {
                        session_id: session_id.clone(),
                        claude_conversation_id: None,
                        model: String::new(),
                        tools: vec![],
                    },
                );
                return;
            }
        };

        log::info!(
            "Starting Claude session: id={}, working_dir={:?}, resume={:?}, claude_binary={}",
            session_id,
            working_dir,
            resume_session_id,
            claude_binary
        );

        let mut cmd = Command::new(&claude_binary);

        // Build args - use --resume if continuing a conversation
        let mut args = vec![
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--dangerously-skip-permissions",
        ];

        // Store resume_id for arg lifetime
        let resume_flag;
        if let Some(ref resume_id) = resume_session_id {
            log::info!("Resuming Claude conversation: {}", resume_id);
            resume_flag = format!("--resume={}", resume_id);
            args.push(&resume_flag);
        }

        cmd.args(&args);

        // Set working directory if provided and it exists
        if let Some(ref dir) = working_dir {
            let path = std::path::Path::new(dir);
            if path.exists() && path.is_dir() {
                log::info!("Setting working directory to: {}", dir);
                cmd.current_dir(dir);
            } else {
                log::warn!(
                    "Working directory does not exist or is not a directory: {}",
                    dir
                );
            }
        }

        let augmented_path = build_augmented_path();
        log::info!(
            "Setting augmented PATH for Claude subprocess: {}",
            augmented_path
        );
        cmd.env("PATH", &augmented_path);

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Spawn the process
        let mut child = match cmd.spawn() {
            Ok(child) => {
                log::info!("Claude process spawned successfully");
                child
            }
            Err(e) => {
                log::error!("Failed to spawn claude at {}: {}", claude_binary, e);
                let _ = ClaudeSessionErrorEvent {
                    session_id: session_id.clone(),
                    error: format!("Failed to spawn claude at {}: {}", claude_binary, e),
                }
                .emit(&app_handle);
                return;
            }
        };

        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Send initial prompt if provided
        if let Some(prompt) = initial_prompt {
            let input_msg = serde_json::json!({
                "type": "user",
                "session_id": &session_id,
                "parent_tool_use_id": null,
                "message": {
                    "role": "user",
                    "content": prompt
                }
            });
            if let Ok(json) = serde_json::to_string(&input_msg) {
                let _ = writeln!(stdin, "{}", json);
                let _ = stdin.flush();
            }
        }

        // Spawn stdout reader thread
        let session_id_for_reader = session_id.clone();
        let app_handle_for_reader = app_handle.clone();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();

        thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            Self::process_jsonl_lines(reader, &session_id_for_reader, |events| {
                for event in events {
                    match event {
                        EmittedEvent::Init(e) => {
                            log::info!(
                                "[Claude Init] conversation_id={:?}, model={}",
                                e.claude_conversation_id,
                                e.model
                            );
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::Text(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::ToolCall(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::ToolResult(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::PermissionRequest(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::Usage(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::SessionEnd(e) => {
                            let _ = e.emit(&app_handle_for_reader);
                        }
                    }
                }
            });
            let _ = exit_tx.send(());
        });

        // Spawn stderr reader thread
        let session_id_for_stderr = session_id.clone();
        let app_handle_for_stderr = app_handle.clone();
        thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            Self::process_stderr_lines(reader, &session_id_for_stderr, |error_msg| {
                let _ = ClaudeSessionErrorEvent {
                    session_id: session_id_for_stderr.clone(),
                    error: error_msg,
                }
                .emit(&app_handle_for_stderr);
            });
        });

        // Forward commands to stdin using sync channel
        let (sync_tx, sync_rx) = std::sync::mpsc::channel::<SessionCommand>();
        let session_id_for_forwarder = session_id.clone();

        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                while let Some(cmd) = command_rx.recv().await {
                    if sync_tx.send(cmd).is_err() {
                        break;
                    }
                }
            });
            log::debug!(
                "Claude session {} command forwarder exited",
                session_id_for_forwarder
            );
        });

        // Main command processing loop
        let mut should_exit = false;

        loop {
            match sync_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(cmd) => match cmd {
                    SessionCommand::SendMessage { content, response } => {
                        let input_msg = serde_json::json!({
                            "type": "user",
                            "session_id": &session_id,
                            "parent_tool_use_id": null,
                            "message": {
                                "role": "user",
                                "content": content
                            }
                        });
                        let result = serde_json::to_string(&input_msg)
                            .map_err(|e| e.to_string())
                            .and_then(|json| {
                                writeln!(stdin, "{}", json).map_err(|e| e.to_string())?;
                                stdin.flush().map_err(|e| e.to_string())
                            });
                        let _ = response.send(result);
                    }
                    SessionCommand::Close { response } => {
                        let _ = response.send(Ok(()));
                        should_exit = true;
                    }
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Check if reader exited
                    if exit_rx.try_recv().is_ok() {
                        should_exit = true;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    should_exit = true;
                }
            }

            if should_exit {
                break;
            }
        }

        // Kill the child process
        let _ = child.kill();
        let _ = child.wait();

        // Clean up session
        let session_id_for_cleanup = session_id.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let mut sessions = sessions.write().await;
                sessions.remove(&session_id_for_cleanup);
            });
        });

        log::info!("Claude session {} ended", session_id);
    }

    /// Process JSONL lines from the Claude CLI stdout.
    /// Parses each non-empty line as a `ClaudeMessage`, builds events, and passes
    /// them to the callback. Stops on read error.
    fn process_jsonl_lines(
        reader: impl BufRead,
        session_id: &str,
        mut on_events: impl FnMut(Vec<EmittedEvent>),
    ) {
        for line in reader.lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    log::info!(
                        "[Claude JSONL] session={} msg={}",
                        &session_id[..8.min(session_id.len())],
                        truncate_utf8(&line, 200)
                    );

                    if let Ok(msg) = serde_json::from_str::<ClaudeMessage>(&line) {
                        let events = Self::build_events(session_id, msg);
                        if !events.is_empty() {
                            on_events(events);
                        }
                    } else {
                        log::warn!(
                            "[Claude JSONL] Failed to parse: {}",
                            truncate_utf8(&line, 100)
                        );
                    }
                }
                Err(e) => {
                    log::error!("Error reading stdout: {}", e);
                    break;
                }
                _ => {}
            }
        }
    }

    /// Process stderr lines from the Claude CLI.
    /// Passes each non-empty line (prefixed with `[stderr]`) to the callback.
    /// Stops on read error.
    fn process_stderr_lines(
        reader: impl BufRead,
        session_id: &str,
        mut on_error: impl FnMut(String),
    ) {
        for line in reader.lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    log::warn!(
                        "[Claude stderr] session={} {}",
                        &session_id[..8.min(session_id.len())],
                        &line[..500.min(line.len())]
                    );
                    on_error(format!("[stderr] {}", line));
                }
                Err(e) => {
                    log::error!("Error reading stderr: {}", e);
                    break;
                }
                _ => {}
            }
        }
    }

    /// Build events from a parsed Claude message without emitting them.
    /// This separates pure event construction from Tauri dispatch for testability.
    fn build_events(session_id: &str, msg: ClaudeMessage) -> Vec<EmittedEvent> {
        let mut events = Vec::new();

        match msg.msg_type.as_str() {
            "system" if msg.subtype.as_deref() == Some("init") => {
                events.push(EmittedEvent::Init(ClaudeSessionInitEvent {
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
                            if delta.delta_type == "text_delta" {
                                if let Some(text) = delta.text {
                                    events.push(EmittedEvent::Text(ClaudeTextEvent {
                                        session_id: session_id.to_string(),
                                        text,
                                        is_partial: true,
                                    }));
                                }
                            }
                        }
                    }
                }
            }
            // Streaming: content_block_delta contains incremental text (direct, non-wrapped)
            "content_block_delta" => {
                if let Some(delta) = msg.delta {
                    if delta.delta_type == "text_delta" {
                        if let Some(text) = delta.text {
                            events.push(EmittedEvent::Text(ClaudeTextEvent {
                                session_id: session_id.to_string(),
                                text,
                                is_partial: true,
                            }));
                        }
                    }
                }
            }
            // Streaming: content_block_start indicates a new block
            "content_block_start" => {
                // We could emit a "start typing" indicator here
                // For now, we just wait for the deltas
            }
            // Streaming: content_block_stop indicates block is complete
            "content_block_stop" => {
                // Could emit a "done typing" indicator here
            }
            "assistant" => {
                if let Some(message) = msg.message {
                    // Emit a per-turn usage event so the UI badge updates
                    // mid-conversation, not only at session_end.
                    if let Some(usage) = message.usage.as_ref() {
                        let context_tokens = usage.input_tokens.unwrap_or(0);
                        events.push(EmittedEvent::Usage(ClaudeSessionUsageEvent {
                            session_id: session_id.to_string(),
                            model: message.model.clone().unwrap_or_default(),
                            context_tokens,
                            // Backend has no per-turn context_window; fall back to the
                            // standard 200k. The frontend uses its own model→max
                            // lookup table as the source of truth for the displayed max.
                            context_window: 200_000,
                        }));
                    }
                    if let Some(content) = message.content {
                        for item in content {
                            match item {
                                ClaudeContentItem::Text { text } => {
                                    events.push(EmittedEvent::Text(ClaudeTextEvent {
                                        session_id: session_id.to_string(),
                                        text,
                                        is_partial: false,
                                    }));
                                }
                                ClaudeContentItem::ToolUse { id, name, input } => {
                                    events.push(EmittedEvent::ToolCall(ClaudeToolCallEvent {
                                        session_id: session_id.to_string(),
                                        tool_id: id,
                                        tool_name: name,
                                        input: serde_json::to_string(&input).unwrap_or_default(),
                                    }));
                                }
                                _ => {}
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

                                // Check if this is a permission request
                                if result_text.contains("Claude requested permissions") {
                                    events.push(EmittedEvent::PermissionRequest(
                                        ClaudePermissionRequestEvent {
                                            session_id: session_id.to_string(),
                                            tool_name: "Read".to_string(),
                                            permission_message: result_text,
                                        },
                                    ));
                                    continue;
                                }

                                events.push(EmittedEvent::ToolResult(ClaudeToolResultEvent {
                                    session_id: session_id.to_string(),
                                    tool_id: tool_use_id,
                                    result: result_text,
                                    is_error,
                                }));
                            }
                        }
                    }
                }
            }
            "result" => {
                // Extract context usage from modelUsage if available
                let (context_tokens, context_window) = msg
                    .model_usage
                    .as_ref()
                    .and_then(|usage| usage.values().next())
                    .map(|stats| {
                        let input = stats.input_tokens.unwrap_or(0);
                        let cache_read = stats.cache_read_input_tokens.unwrap_or(0);
                        let cache_creation = stats.cache_creation_input_tokens.unwrap_or(0);
                        let output = stats.output_tokens.unwrap_or(0);
                        let total = input + cache_read + cache_creation + output;
                        let window = stats.context_window.unwrap_or(200_000);
                        (total, window)
                    })
                    .unwrap_or((0, 200_000));

                events.push(EmittedEvent::SessionEnd(ClaudeSessionEndEvent {
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

    /// Send a message to a Claude session
    pub async fn send_message(
        &self,
        session_id: &str,
        content: &str,
    ) -> Result<(), ClaudeSessionError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ClaudeSessionError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(SessionCommand::SendMessage {
                content: content.to_string(),
                response: response_tx,
            })
            .map_err(|_| ClaudeSessionError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| ClaudeSessionError::SendFailed("Session closed".to_string()))?
            .map_err(ClaudeSessionError::SendFailed)
    }

    /// Close a Claude session
    pub async fn close_session(&self, session_id: &str) -> Result<(), ClaudeSessionError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ClaudeSessionError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(SessionCommand::Close {
                response: response_tx,
            })
            .map_err(|_| ClaudeSessionError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| ClaudeSessionError::SessionNotFound("Session closed".to_string()))?
            .map_err(ClaudeSessionError::SessionNotFound)
    }

    /// Check if a session exists
    pub async fn has_session(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        sessions.contains_key(session_id)
    }
}

impl Default for ClaudeSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Claude session errors
#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
pub enum ClaudeSessionError {
    #[error("Session already exists: {0}")]
    SessionExists(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to send message: {0}")]
    SendFailed(String),
    #[error("Failed to spawn Claude: {0}")]
    SpawnFailed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_session_manager_new() {
        let manager = ClaudeSessionManager::new();
        assert_eq!(manager.sessions.blocking_read().len(), 0);
    }

    #[test]
    fn test_claude_session_manager_default() {
        let manager = ClaudeSessionManager::default();
        assert_eq!(manager.sessions.blocking_read().len(), 0);
    }

    #[tokio::test]
    async fn test_has_session_empty() {
        let manager = ClaudeSessionManager::new();
        assert!(!manager.has_session("non-existent").await);
    }

    #[tokio::test]
    async fn test_send_message_session_not_found() {
        let manager = ClaudeSessionManager::new();
        let result = manager.send_message("non-existent", "test").await;
        assert!(result.is_err());
        match result {
            Err(ClaudeSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    #[tokio::test]
    async fn test_close_session_not_found() {
        let manager = ClaudeSessionManager::new();
        let result = manager.close_session("non-existent").await;
        assert!(result.is_err());
        match result {
            Err(ClaudeSessionError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    #[test]
    fn test_claude_session_error_display() {
        let err = ClaudeSessionError::SessionNotFound("test-123".to_string());
        assert_eq!(err.to_string(), "Session not found: test-123");

        let err = ClaudeSessionError::SessionExists("test-456".to_string());
        assert_eq!(err.to_string(), "Session already exists: test-456");

        let err = ClaudeSessionError::SendFailed("IO error".to_string());
        assert_eq!(err.to_string(), "Failed to send message: IO error");
    }

    #[test]
    fn test_event_serialization() {
        let init_event = ClaudeSessionInitEvent {
            session_id: "test-session".to_string(),
            claude_conversation_id: Some("conv-123".to_string()),
            model: "claude-sonnet-4".to_string(),
            tools: vec!["Read".to_string(), "Edit".to_string()],
        };
        let json = serde_json::to_string(&init_event).expect("Should serialize");
        assert!(json.contains("test-session"));
        assert!(json.contains("claude-sonnet-4"));
        assert!(json.contains("conv-123"));

        let text_event = ClaudeTextEvent {
            session_id: "test".to_string(),
            text: "Hello world".to_string(),
            is_partial: false,
        };
        let json = serde_json::to_string(&text_event).expect("Should serialize");
        assert!(json.contains("Hello world"));

        let tool_call_event = ClaudeToolCallEvent {
            session_id: "test".to_string(),
            tool_id: "toolu_123".to_string(),
            tool_name: "Read".to_string(),
            input: r#"{"file_path":"/test.txt"}"#.to_string(),
        };
        let json = serde_json::to_string(&tool_call_event).expect("Should serialize");
        assert!(json.contains("toolu_123"));
        assert!(json.contains("Read"));

        let end_event = ClaudeSessionEndEvent {
            session_id: "test".to_string(),
            duration_ms: 5000,
            cost_usd: 0.05,
            num_turns: 3,
            result: "Done".to_string(),
            is_error: false,
            context_tokens: 0,
            context_window: 0,
        };
        let json = serde_json::to_string(&end_event).expect("Should serialize");
        assert!(json.contains("5000"));
        assert!(json.contains("0.05"));
    }

    #[test]
    fn test_utf8_safe_truncation_does_not_panic() {
        // '…' (U+2026) is 3 bytes in UTF-8 (0xE2 0x80 0xA6).
        // Place it so a naive byte slice at 200 would land inside the character.
        let line = "a".repeat(198) + "…" + &"b".repeat(50); // '…' spans bytes 198..201
        assert_eq!(line.len(), 251); // 198 + 3 + 50

        // Truncation at 200 must not panic and must land on a char boundary
        let truncated = truncate_utf8(&line, 200);
        assert!(truncated.is_char_boundary(truncated.len()));
        // Should truncate before the '…' since byte 200 is inside it
        assert_eq!(truncated.len(), 198);
        assert_eq!(truncated, "a".repeat(198).as_str());

        // Same test for the 100-byte truncation path
        let line_100 = "x".repeat(98) + "…" + &"y".repeat(50); // '…' spans bytes 98..101
        assert_eq!(line_100.len(), 151);

        let truncated_100 = truncate_utf8(&line_100, 100);
        assert!(truncated_100.is_char_boundary(truncated_100.len()));
        assert_eq!(truncated_100.len(), 98);
        assert_eq!(truncated_100, "x".repeat(98).as_str());
    }

    #[test]
    fn test_utf8_safe_truncation_with_string_shorter_than_limit() {
        let short = "hello…world";
        let len = short.len(); // "hello" = 5, "…" = 3, "world" = 5 => 13
        assert_eq!(len, 13);

        let truncated = truncate_utf8(short, 200);
        assert_eq!(truncated, short);
    }

    #[test]
    fn test_utf8_safe_truncation_zero_max_bytes() {
        let s = "hello";
        let truncated = truncate_utf8(s, 0);
        assert_eq!(truncated, "");
    }

    #[test]
    fn test_utf8_safe_truncation_all_multibyte() {
        // All 3-byte characters — truncating at 1 or 2 must walk back to 0
        let s = "………"; // 3 × 3 bytes = 9 bytes
        assert_eq!(s.len(), 9);

        assert_eq!(truncate_utf8(s, 1), "");
        assert_eq!(truncate_utf8(s, 2), "");
        assert_eq!(truncate_utf8(s, 3), "…");
        assert_eq!(truncate_utf8(s, 5), "…");
        assert_eq!(truncate_utf8(s, 6), "……");
    }

    #[test]
    fn test_utf8_safe_truncation_exact_boundary() {
        let s = "abc…def"; // 3 + 3 + 3 = 9 bytes
        assert_eq!(s.len(), 9);

        // Truncate exactly at char boundary
        assert_eq!(truncate_utf8(s, 3), "abc");
        assert_eq!(truncate_utf8(s, 6), "abc…");
        assert_eq!(truncate_utf8(s, 9), "abc…def");
    }

    // ========================================================================
    // has_session with existing session
    // ========================================================================

    #[tokio::test]
    async fn test_has_session_existing() {
        let manager = ClaudeSessionManager::new();
        let (tx, _rx) = mpsc::unbounded_channel();
        {
            let mut sessions = manager.sessions.write().await;
            sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
        }
        assert!(manager.has_session("test-session").await);
        assert!(!manager.has_session("other-session").await);
    }

    #[tokio::test]
    async fn test_send_message_channel_dropped() {
        let manager = ClaudeSessionManager::new();
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        {
            let mut sessions = manager.sessions.write().await;
            sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
        }
        let result = manager.send_message("test-session", "hello").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_close_session_channel_dropped() {
        let manager = ClaudeSessionManager::new();
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        {
            let mut sessions = manager.sessions.write().await;
            sessions.insert("test-session".to_string(), SessionHandle { command_tx: tx });
        }
        let result = manager.close_session("test-session").await;
        assert!(result.is_err());
    }

    // ========================================================================
    // build_events tests
    // ========================================================================

    fn parse_msg(json: &str) -> ClaudeMessage {
        serde_json::from_str(json).expect("Failed to parse test ClaudeMessage JSON")
    }

    #[test]
    fn test_build_events_system_init() {
        let msg = parse_msg(
            r#"{
                "type": "system",
                "subtype": "init",
                "session_id": "conv-abc",
                "uuid": "uuid-123",
                "model": "claude-sonnet-4",
                "tools": ["Read", "Edit"]
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::Init(e) => {
                assert_eq!(e.session_id, "sess-1");
                // session_id takes precedence over uuid
                assert_eq!(e.claude_conversation_id, Some("conv-abc".to_string()));
                assert_eq!(e.model, "claude-sonnet-4");
                assert_eq!(e.tools, vec!["Read", "Edit"]);
            }
            other => panic!("Expected Init event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_system_init_fallback_to_uuid() {
        let msg = parse_msg(
            r#"{
                "type": "system",
                "subtype": "init",
                "uuid": "uuid-123",
                "model": "claude-sonnet-4"
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::Init(e) => {
                assert_eq!(e.claude_conversation_id, Some("uuid-123".to_string()));
            }
            other => panic!("Expected Init event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_system_non_init() {
        let msg = parse_msg(r#"{"type": "system", "subtype": "other"}"#);
        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert!(events.is_empty());
    }

    #[test]
    fn test_build_events_system_no_subtype() {
        let msg = parse_msg(r#"{"type": "system"}"#);
        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert!(events.is_empty());
    }

    #[test]
    fn test_build_events_stream_event_text_delta() {
        let msg = parse_msg(
            r#"{
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "text_delta",
                        "text": "Hello"
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::Text(e) => {
                assert_eq!(e.session_id, "sess-1");
                assert_eq!(e.text, "Hello");
                assert!(e.is_partial);
            }
            other => panic!("Expected Text event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_stream_event_non_text_delta_type() {
        let msg = parse_msg(
            r#"{
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "input_json_delta",
                        "text": "ignored"
                    }
                }
            }"#,
        );
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_stream_event_non_delta_event() {
        let msg = parse_msg(
            r#"{
                "type": "stream_event",
                "event": {
                    "type": "content_block_start"
                }
            }"#,
        );
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_stream_event_no_event_field() {
        let msg = parse_msg(r#"{"type": "stream_event"}"#);
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_content_block_delta_direct() {
        let msg = parse_msg(
            r#"{
                "type": "content_block_delta",
                "delta": {
                    "type": "text_delta",
                    "text": "World"
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::Text(e) => {
                assert_eq!(e.text, "World");
                assert!(e.is_partial);
            }
            other => panic!("Expected Text event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_content_block_delta_non_text() {
        let msg = parse_msg(
            r#"{
                "type": "content_block_delta",
                "delta": {"type": "input_json_delta"}
            }"#,
        );
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_content_block_start_stop_are_noop() {
        let msg = parse_msg(r#"{"type": "content_block_start"}"#);
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());

        let msg = parse_msg(r#"{"type": "content_block_stop"}"#);
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_assistant_text() {
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Hello from Claude"}
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::Text(e) => {
                assert_eq!(e.text, "Hello from Claude");
                assert!(!e.is_partial);
            }
            other => panic!("Expected Text event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_assistant_tool_use() {
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_123",
                            "name": "Read",
                            "input": {"file_path": "/test.txt"}
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::ToolCall(e) => {
                assert_eq!(e.tool_id, "toolu_123");
                assert_eq!(e.tool_name, "Read");
                assert!(e.input.contains("file_path"));
            }
            other => panic!("Expected ToolCall event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_assistant_mixed_content() {
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Let me read that"},
                        {"type": "tool_use", "id": "toolu_456", "name": "Read", "input": {}}
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], EmittedEvent::Text(_)));
        assert!(matches!(&events[1], EmittedEvent::ToolCall(_)));
    }

    #[test]
    fn test_build_events_assistant_no_message() {
        let msg = parse_msg(r#"{"type": "assistant"}"#);
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_user_tool_result() {
        let msg = parse_msg(
            r#"{
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_123",
                            "content": "file contents here",
                            "is_error": false
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::ToolResult(e) => {
                assert_eq!(e.tool_id, "toolu_123");
                assert_eq!(e.result, "file contents here");
                assert!(!e.is_error);
            }
            other => panic!("Expected ToolResult event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_user_tool_result_error() {
        let msg = parse_msg(
            r#"{
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_err",
                            "content": "something broke",
                            "is_error": true
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::ToolResult(e) => {
                assert!(e.is_error);
                assert_eq!(e.result, "something broke");
            }
            other => panic!("Expected ToolResult event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_user_tool_result_json_content() {
        let msg = parse_msg(
            r#"{
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_json",
                            "content": {"key": "value"},
                            "is_error": false
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::ToolResult(e) => {
                assert!(e.result.contains("key"));
                assert!(e.result.contains("value"));
            }
            other => panic!("Expected ToolResult event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_user_permission_request() {
        let msg = parse_msg(
            r#"{
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_perm",
                            "content": "Claude requested permissions to read /etc/passwd",
                            "is_error": false
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::PermissionRequest(e) => {
                assert_eq!(e.tool_name, "Read");
                assert!(e
                    .permission_message
                    .contains("Claude requested permissions"));
            }
            other => panic!("Expected PermissionRequest event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_user_mixed_results_and_permissions() {
        // A message with both a regular tool result and a permission request
        let msg = parse_msg(
            r#"{
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "normal result",
                            "is_error": false
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_2",
                            "content": "Claude requested permissions for X",
                            "is_error": false
                        }
                    ]
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], EmittedEvent::ToolResult(_)));
        assert!(matches!(&events[1], EmittedEvent::PermissionRequest(_)));
    }

    #[test]
    fn test_build_events_assistant_emits_usage_event() {
        // Per-turn usage event should fire whenever the assistant message
        // carries a `usage` block, using `input_tokens` (non-cached) as the
        // context-size figure.
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-opus-4-7-20250115",
                    "content": [{"type": "text", "text": "hi"}],
                    "usage": {
                        "input_tokens": 12345,
                        "cache_read_input_tokens": 9999,
                        "cache_creation_input_tokens": 8888,
                        "output_tokens": 250
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 2, "expected Usage + Text events");
        match &events[0] {
            EmittedEvent::Usage(e) => {
                assert_eq!(e.session_id, "sess-1");
                assert_eq!(e.model, "claude-opus-4-7-20250115");
                // input_tokens only — cache_read/cache_creation/output excluded
                assert_eq!(e.context_tokens, 12345);
                assert_eq!(e.context_window, 200_000);
            }
            other => panic!("Expected Usage event first, got {:?}", other),
        }
        assert!(matches!(&events[1], EmittedEvent::Text(_)));
    }

    #[test]
    fn test_build_events_assistant_no_usage_no_event() {
        // When `usage` is absent, no Usage event is emitted.
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello"}]
                }
            }"#,
        );
        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], EmittedEvent::Text(_)));
    }

    #[test]
    fn test_build_events_result_with_usage() {
        let msg = parse_msg(
            r#"{
                "type": "result",
                "duration_ms": 5000,
                "num_turns": 3,
                "total_cost_usd": 0.05,
                "result": "Task completed",
                "is_error": false,
                "modelUsage": {
                    "claude-sonnet-4": {
                        "inputTokens": 1000,
                        "outputTokens": 500,
                        "cacheReadInputTokens": 200,
                        "cacheCreationInputTokens": 100,
                        "contextWindow": 200000
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => {
                assert_eq!(e.session_id, "sess-1");
                assert_eq!(e.duration_ms, 5000);
                assert_eq!(e.num_turns, 3);
                assert_eq!(e.cost_usd, 0.05);
                assert_eq!(e.result, "Task completed");
                assert!(!e.is_error);
                // 1000 + 500 + 200 + 100 = 1800
                assert_eq!(e.context_tokens, 1800);
                assert_eq!(e.context_window, 200_000);
            }
            other => panic!("Expected SessionEnd event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_result_no_usage() {
        let msg = parse_msg(
            r#"{
                "type": "result",
                "duration_ms": 1000,
                "result": "Done"
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => {
                assert_eq!(e.context_tokens, 0);
                assert_eq!(e.context_window, 200_000);
                assert_eq!(e.duration_ms, 1000);
            }
            other => panic!("Expected SessionEnd event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_result_is_error() {
        let msg = parse_msg(
            r#"{
                "type": "result",
                "result": "Something went wrong",
                "is_error": true
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => {
                assert!(e.is_error);
                assert_eq!(e.result, "Something went wrong");
            }
            other => panic!("Expected SessionEnd event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_result_token_arithmetic() {
        // Verify each component contributes to the total
        let msg = parse_msg(
            r#"{
                "type": "result",
                "modelUsage": {
                    "model-x": {
                        "inputTokens": 10,
                        "outputTokens": 20,
                        "cacheReadInputTokens": 30,
                        "cacheCreationInputTokens": 40,
                        "contextWindow": 100000
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => {
                // 10 + 20 + 30 + 40 = 100
                assert_eq!(e.context_tokens, 100);
                assert_eq!(e.context_window, 100_000);
            }
            other => panic!("Expected SessionEnd event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_unknown_type() {
        let msg = parse_msg(r#"{"type": "unknown_type"}"#);
        assert!(ClaudeSessionManager::build_events("sess-1", msg).is_empty());
    }

    #[test]
    fn test_build_events_session_id_propagation() {
        // Verify the session_id parameter is correctly set on all event types
        let test_sid = "my-unique-session-42";

        let msg = parse_msg(r#"{"type": "system", "subtype": "init"}"#);
        let events = ClaudeSessionManager::build_events(test_sid, msg);
        match &events[0] {
            EmittedEvent::Init(e) => assert_eq!(e.session_id, test_sid),
            other => panic!("Expected Init, got {:?}", other),
        }

        let msg = parse_msg(
            r#"{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "x"}}"#,
        );
        let events = ClaudeSessionManager::build_events(test_sid, msg);
        match &events[0] {
            EmittedEvent::Text(e) => assert_eq!(e.session_id, test_sid),
            other => panic!("Expected Text, got {:?}", other),
        }

        let msg = parse_msg(r#"{"type": "result"}"#);
        let events = ClaudeSessionManager::build_events(test_sid, msg);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => assert_eq!(e.session_id, test_sid),
            other => panic!("Expected SessionEnd, got {:?}", other),
        }
    }

    // ========================================================================
    // Shared test helpers
    // ========================================================================

    /// A reader that yields its data then returns errors forever.
    /// Use this to test that processing stops on read error.
    struct FailingReader {
        data: std::io::Cursor<Vec<u8>>,
        has_errored: bool,
    }

    impl FailingReader {
        fn new(data: &str) -> Self {
            Self {
                data: std::io::Cursor::new(data.as_bytes().to_vec()),
                has_errored: false,
            }
        }
    }

    impl std::io::Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.has_errored {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe broke",
                ));
            }
            let n = self.data.read(buf)?;
            if n == 0 {
                self.has_errored = true;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe broke",
                ));
            }
            Ok(n)
        }
    }

    impl BufRead for FailingReader {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            if self.has_errored {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe broke",
                ));
            }
            let buf = self.data.fill_buf()?;
            if buf.is_empty() {
                self.has_errored = true;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe broke",
                ));
            }
            Ok(buf)
        }
        fn consume(&mut self, amt: usize) {
            self.data.consume(amt);
        }
    }

    // ========================================================================
    // process_jsonl_lines tests
    // ========================================================================

    #[test]
    fn test_process_jsonl_lines_parses_and_emits() {
        let input = concat!(
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-4"}"#,
            "\n",
            r#"{"type":"result","duration_ms":100}"#,
            "\n",
        );

        let mut all_events = Vec::new();
        ClaudeSessionManager::process_jsonl_lines(
            std::io::Cursor::new(input),
            "sess-1",
            |events| all_events.extend(events),
        );

        assert_eq!(all_events.len(), 2);
        assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
        assert!(matches!(&all_events[1], EmittedEvent::SessionEnd(_)));
    }

    #[test]
    fn test_process_jsonl_lines_skips_empty_lines() {
        let input = concat!(
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            "\n",
            "\n",
            r#"{"type":"result"}"#,
            "\n",
        );

        let mut count = 0;
        ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(input), "sess-1", |_| {
            count += 1
        });

        // Two valid messages, empty lines skipped
        assert_eq!(count, 2);
    }

    #[test]
    fn test_process_jsonl_lines_skips_invalid_json() {
        let input = concat!(
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            "not valid json\n",
            r#"{"type":"result"}"#,
            "\n",
        );

        let mut all_events = Vec::new();
        ClaudeSessionManager::process_jsonl_lines(
            std::io::Cursor::new(input),
            "sess-1",
            |events| all_events.extend(events),
        );

        // Only the two valid messages should produce events
        assert_eq!(all_events.len(), 2);
    }

    #[test]
    fn test_process_jsonl_lines_empty_input() {
        let mut called = false;
        ClaudeSessionManager::process_jsonl_lines(std::io::Cursor::new(""), "sess-1", |_| {
            called = true
        });
        assert!(!called);
    }

    #[test]
    fn test_process_jsonl_lines_stops_on_read_error() {
        let input = format!("{}\n", r#"{"type":"system","subtype":"init"}"#);
        let reader = FailingReader::new(&input);

        let mut all_events = Vec::new();
        ClaudeSessionManager::process_jsonl_lines(reader, "sess-1", |events| {
            all_events.extend(events)
        });

        // Should have processed the one valid line before the error
        assert_eq!(all_events.len(), 1);
        assert!(matches!(&all_events[0], EmittedEvent::Init(_)));
    }

    // ========================================================================
    // process_stderr_lines tests
    // ========================================================================

    #[test]
    fn test_process_stderr_lines_collects_errors() {
        let input = "something went wrong\nanother error\n";

        let mut errors = Vec::new();
        ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(input), "sess-1", |msg| {
            errors.push(msg)
        });

        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0], "[stderr] something went wrong");
        assert_eq!(errors[1], "[stderr] another error");
    }

    #[test]
    fn test_process_stderr_lines_skips_empty_lines() {
        let input = "error one\n\n\nerror two\n";

        let mut errors = Vec::new();
        ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(input), "sess-1", |msg| {
            errors.push(msg)
        });

        assert_eq!(errors.len(), 2);
    }

    #[test]
    fn test_process_stderr_lines_empty_input() {
        let mut called = false;
        ClaudeSessionManager::process_stderr_lines(std::io::Cursor::new(""), "sess-1", |_| {
            called = true
        });
        assert!(!called);
    }

    #[test]
    fn test_process_stderr_lines_stops_on_read_error() {
        let reader = FailingReader::new("first error\n");

        let mut errors = Vec::new();
        ClaudeSessionManager::process_stderr_lines(reader, "sess-1", |msg| errors.push(msg));

        // Should have processed the one valid line before the error
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0], "[stderr] first error");
    }

    // ========================================================================
    // build_augmented_path tests
    // ========================================================================

    #[test]
    fn test_build_augmented_path_contains_cargo_bin() {
        let path = build_augmented_path();
        let home = dirs::home_dir().expect("test requires HOME to be set");
        let cargo_bin = home.join(".cargo").join("bin");
        let cargo_bin_str = cargo_bin.to_string_lossy();

        assert!(
            path.contains(&*cargo_bin_str),
            "PATH should contain {}, got: {}",
            cargo_bin_str,
            path
        );
    }

    #[test]
    fn test_build_augmented_path_contains_homebrew_bin() {
        let path = build_augmented_path();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "PATH should contain /opt/homebrew/bin, got: {}",
            path
        );
    }

    #[test]
    fn test_build_augmented_path_contains_usr_local_bin() {
        let path = build_augmented_path();
        assert!(
            path.contains("/usr/local/bin"),
            "PATH should contain /usr/local/bin, got: {}",
            path
        );
    }

    #[test]
    fn test_build_augmented_path_preserves_existing_path() {
        // The current process PATH should appear in the augmented result
        let current = std::env::var("PATH").unwrap_or_default();
        if !current.is_empty() {
            let path = build_augmented_path();
            assert!(
                path.contains(&current),
                "Augmented PATH should contain the original PATH '{}', got: {}",
                current,
                path
            );
        }
    }

    #[test]
    fn test_build_augmented_path_cargo_bin_before_existing_path() {
        let path = build_augmented_path();
        let home = dirs::home_dir().expect("test requires HOME to be set");
        let cargo_bin = home
            .join(".cargo")
            .join("bin")
            .to_string_lossy()
            .to_string();

        let cargo_pos = path.find(&cargo_bin).expect("cargo/bin should be in PATH");
        let current = std::env::var("PATH").unwrap_or_default();
        if !current.is_empty() {
            // Find the start of the original PATH within the augmented one.
            // The original PATH is appended as the last segment, so find it from the end.
            let original_pos = path
                .rfind(&current)
                .expect("original PATH should be in PATH");
            assert!(
                cargo_pos < original_pos,
                "~/.cargo/bin (pos {}) should appear before the original PATH (pos {})",
                cargo_pos,
                original_pos
            );
        }
    }

    #[test]
    fn test_build_augmented_path_is_colon_separated() {
        let path = build_augmented_path();
        let segments: Vec<&str> = path.split(':').collect();
        // At minimum: ~/.cargo/bin, /opt/homebrew/bin, /usr/local/bin
        assert!(
            segments.len() >= 3,
            "PATH should have at least 3 segments, got {}: {}",
            segments.len(),
            path
        );
    }
}
