//! Claude CLI session management with JSONL streaming
//!
//! Provides structured chat interaction with Claude CLI using
//! streaming JSON input/output instead of PTY-based terminal emulation.

#![allow(dead_code)] // Some fields are parsed but not yet used

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::Emitter;
use tauri_specta::Event;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::workflow_runner::find_claude_binary;

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
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);

            for line in reader.lines() {
                match line {
                    Ok(line) if !line.is_empty() => {
                        // Log all received JSONL messages for debugging
                        log::info!(
                            "[Claude JSONL] session={} msg={}",
                            &session_id_for_reader[..8.min(session_id_for_reader.len())],
                            &line[..200.min(line.len())]
                        );

                        if let Ok(msg) = serde_json::from_str::<ClaudeMessage>(&line) {
                            Self::emit_events(&session_id_for_reader, msg, &app_handle_for_reader);
                        } else {
                            log::warn!(
                                "[Claude JSONL] Failed to parse: {}",
                                &line[..100.min(line.len())]
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

            let _ = exit_tx.send(());
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

    /// Emit appropriate events based on the parsed message
    fn emit_events(session_id: &str, msg: ClaudeMessage, app_handle: &tauri::AppHandle) {
        match msg.msg_type.as_str() {
            "system" if msg.subtype.as_deref() == Some("init") => {
                // Log the full init message to see what fields are available
                log::info!(
                    "[Claude Init] uuid={:?}, session_id={:?}, model={:?}",
                    msg.uuid,
                    msg.session_id,
                    msg.model
                );
                let _ = ClaudeSessionInitEvent {
                    session_id: session_id.to_string(),
                    // Try session_id first, fall back to uuid
                    claude_conversation_id: msg.session_id.or(msg.uuid),
                    model: msg.model.unwrap_or_default(),
                    tools: msg.tools.unwrap_or_default(),
                }
                .emit(app_handle);
            }
            // Streaming: stream_event wraps content_block_delta and other streaming events
            "stream_event" => {
                if let Some(event) = msg.event {
                    if event.event_type == "content_block_delta" {
                        if let Some(delta) = event.delta {
                            if delta.delta_type == "text_delta" {
                                if let Some(text) = delta.text {
                                    let _ = ClaudeTextEvent {
                                        session_id: session_id.to_string(),
                                        text,
                                        is_partial: true,
                                    }
                                    .emit(app_handle);
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
                            let _ = ClaudeTextEvent {
                                session_id: session_id.to_string(),
                                text,
                                is_partial: true,
                            }
                            .emit(app_handle);
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
                    if let Some(content) = message.content {
                        for item in content {
                            match item {
                                ClaudeContentItem::Text { text } => {
                                    let _ = ClaudeTextEvent {
                                        session_id: session_id.to_string(),
                                        text,
                                        is_partial: false,
                                    }
                                    .emit(app_handle);
                                }
                                ClaudeContentItem::ToolUse { id, name, input } => {
                                    let _ = ClaudeToolCallEvent {
                                        session_id: session_id.to_string(),
                                        tool_id: id,
                                        tool_name: name,
                                        input: serde_json::to_string(&input).unwrap_or_default(),
                                    }
                                    .emit(app_handle);
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

                                // Check if this is a permission request - emit permission event and skip tool result
                                if result_text.contains("Claude requested permissions") {
                                    let _ = ClaudePermissionRequestEvent {
                                        session_id: session_id.to_string(),
                                        tool_name: "Read".to_string(),
                                        permission_message: result_text,
                                    }
                                    .emit(app_handle);
                                    continue; // Skip emitting tool result for permission requests
                                }

                                let _ = ClaudeToolResultEvent {
                                    session_id: session_id.to_string(),
                                    tool_id: tool_use_id,
                                    result: result_text,
                                    is_error,
                                }
                                .emit(app_handle);
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

                let _ = ClaudeSessionEndEvent {
                    session_id: session_id.to_string(),
                    duration_ms: msg.duration_ms.unwrap_or(0),
                    cost_usd: msg.total_cost_usd.unwrap_or(0.0),
                    num_turns: msg.num_turns.unwrap_or(0),
                    result: msg.result.unwrap_or_default(),
                    is_error: msg.is_error.unwrap_or(false),
                    context_tokens,
                    context_window,
                }
                .emit(app_handle);
            }
            _ => {}
        }
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
}
