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
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Emitter;
use tauri_specta::Event;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::events::PermissionRequestEvent;
use crate::helpers::{find_claude_binary, find_vtb_gate_binary};

#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;
#[cfg(unix)]
const PERMISSION_SOCKET_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const DEFAULT_CONTEXT_WINDOW: u32 = 200_000;
const DEFAULT_CLAUDE_MODEL_ID: &str = "sonnet";
const SUPPORTED_CLAUDE_MODELS: &[ClaudeModelDefinition] = &[
    ClaudeModelDefinition {
        id: "sonnet",
        label: "Sonnet",
    },
    ClaudeModelDefinition {
        id: "opus",
        label: "Opus",
    },
    ClaudeModelDefinition {
        id: "haiku",
        label: "Haiku",
    },
    ClaudeModelDefinition {
        id: "fable",
        label: "Fable",
    },
];

#[derive(Debug, Clone, Copy)]
struct ClaudeModelDefinition {
    id: &'static str,
    label: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelCatalog {
    pub default_model_id: String,
    pub models: Vec<ClaudeModelOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedClaudeModel {
    model_id: Option<String>,
    warning: Option<String>,
}

/// Build an augmented PATH that prepends commonly needed directories for macOS GUI apps.
///
/// macOS GUI applications inherit a minimal PATH (typically just `/usr/bin:/bin:/usr/sbin:/sbin`)
/// because they don't source shell profiles. This function prepends `~/.cargo/bin`,
/// `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` so that tools installed via cargo,
/// the Vertebrae installer, Homebrew, or manually into `/usr/local/bin` are discoverable by
/// subprocesses.
fn build_augmented_path() -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".cargo/bin").to_string_lossy().into_owned());
        parts.push(home.join(".local/bin").to_string_lossy().into_owned());
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
    /// `tool_use` id of the parent spawn (Task/Agent) tool call when this call
    /// was made by a sub-agent; `None` for main-thread calls. Drives sub-agent
    /// nesting in the chat thread.
    pub parent_tool_use_id: Option<String>,
}

/// Event emitted when a tool returns a result
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeToolResultEvent {
    pub session_id: String,
    pub tool_id: String,
    pub result: String,
    pub is_error: bool,
    /// Parent spawn `tool_use` id when this result belongs to a sub-agent;
    /// `None` for main-thread results. See [`ClaudeToolCallEvent`].
    pub parent_tool_use_id: Option<String>,
}

/// Event emitted after each assistant message with the latest input-context figure.
///
/// `context_tokens` is the total request input for the most recent assistant
/// turn: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
/// This is the source of truth for the chat badge's current request context
/// occupancy. Output tokens are excluded because they are response tokens, not
/// request input.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionUsageEvent {
    pub session_id: String,
    /// Model name reported by the assistant message
    pub model: String,
    /// Current request input-context tokens for the latest assistant turn
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
    /// Sum of per-model input contexts from result model usage (input + cache,
    /// excluding output). This is a session summary and may exceed any single
    /// model's context window.
    pub context_tokens: u32,
    /// Maximum reported model context window size
    pub context_window: u32,
}

/// Event emitted when Claude session encounters an error
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionErrorEvent {
    pub session_id: String,
    pub error: String,
}

/// Event emitted when Claude session startup recovers from a non-fatal issue.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudeSessionWarningEvent {
    pub session_id: String,
    pub warning: String,
}

/// Event emitted when Claude requests permission
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ClaudePermissionRequestEvent {
    pub session_id: String,
    pub tool_name: String,
    pub permission_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPermissionDecision {
    pub behavior: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct PermissionSocketRequest {
    request_id: String,
    tool_name: String,
    tool_use_id: String,
    #[serde(default)]
    input: serde_json::Value,
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
    model_usage: Option<std::collections::HashMap<String, ModelUsageStats>>,
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
    // surface the model's context window — the one field that is meaningful.
    usage
        .values()
        .filter_map(|stats| stats.context_window)
        .max()
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

pub fn supported_claude_model_catalog() -> ClaudeModelCatalog {
    ClaudeModelCatalog {
        default_model_id: DEFAULT_CLAUDE_MODEL_ID.to_string(),
        models: SUPPORTED_CLAUDE_MODELS
            .iter()
            .map(|model| ClaudeModelOption {
                id: model.id.to_string(),
                label: model.label.to_string(),
            })
            .collect(),
    }
}

fn is_supported_claude_model_id(model_id: &str) -> bool {
    SUPPORTED_CLAUDE_MODELS
        .iter()
        .any(|model| model.id == model_id)
}

fn safe_warning_model_id(model_id: &str) -> String {
    model_id
        .chars()
        .flat_map(|ch| ch.escape_default())
        .collect()
}

fn resolve_requested_claude_model(
    model_id: Option<String>,
    is_resume: bool,
) -> ResolvedClaudeModel {
    let Some(model_id) = model_id else {
        return ResolvedClaudeModel {
            model_id: None,
            warning: None,
        };
    };
    let normalized = model_id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return ResolvedClaudeModel {
            model_id: None,
            warning: None,
        };
    }
    if is_supported_claude_model_id(&normalized) {
        return ResolvedClaudeModel {
            model_id: Some(normalized),
            warning: None,
        };
    }

    let safe_model_id = safe_warning_model_id(&normalized);
    if is_resume {
        return ResolvedClaudeModel {
            model_id: None,
            warning: Some(format!(
                "Unsupported Claude model '{}'; resuming with the conversation's original model.",
                safe_model_id
            )),
        };
    }

    ResolvedClaudeModel {
        model_id: Some(DEFAULT_CLAUDE_MODEL_ID.to_string()),
        warning: Some(format!(
            "Unsupported Claude model '{}'; falling back to default model '{}'.",
            safe_model_id, DEFAULT_CLAUDE_MODEL_ID
        )),
    }
}

fn build_claude_args(
    mcp_config: &str,
    resume_session_id: Option<&str>,
    model_id: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--mcp-config".to_string(),
        mcp_config.to_string(),
        "--permission-prompt-tool".to_string(),
        "mcp__vtb-gate__permission_prompt".to_string(),
    ];

    if let Some(model_id) = model_id {
        args.push("--model".to_string());
        args.push(model_id.to_string());
    }

    if let Some(resume_id) = resume_session_id {
        args.push(format!("--resume={}", resume_id));
    }

    args
}

/// Nested event structure inside stream_event messages
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

struct PendingPermission {
    session_id: String,
    response_tx: std::sync::mpsc::Sender<LocalPermissionDecision>,
}

struct SessionRuntimeState {
    app_handle: tauri::AppHandle,
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

#[cfg(unix)]
struct PermissionSocketGuard {
    path: std::path::PathBuf,
    directory: std::path::PathBuf,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(unix)]
impl PermissionSocketGuard {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(unix)]
impl Drop for PermissionSocketGuard {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Err(err) = std::fs::remove_file(&self.path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to remove vtb-gate permission socket {:?}: {}",
                    self.path,
                    err
                );
            }
        }
        if let Err(err) = std::fs::remove_dir(&self.directory) {
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to remove vtb-gate permission socket directory {:?}: {}",
                    self.directory,
                    err
                );
            }
        }
    }
}

/// Manages active Claude CLI sessions
pub struct ClaudeSessionManager {
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

impl ClaudeSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
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
        requested_model_id: Option<String>,
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
        let runtime_state = SessionRuntimeState {
            app_handle,
            sessions: self.sessions.clone(),
            pending_permissions: self.pending_permissions.clone(),
        };
        let session_id_clone = session_id.clone();
        thread::spawn(move || {
            Self::run_session(
                session_id_clone,
                working_dir,
                initial_prompt,
                resume_session_id,
                requested_model_id,
                command_rx,
                runtime_state,
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
        requested_model_id: Option<String>,
        mut command_rx: mpsc::UnboundedReceiver<SessionCommand>,
        runtime_state: SessionRuntimeState,
    ) {
        let SessionRuntimeState {
            app_handle,
            sessions,
            pending_permissions,
        } = runtime_state;
        let resolved_model =
            resolve_requested_claude_model(requested_model_id, resume_session_id.is_some());
        if let Some(warning) = &resolved_model.warning {
            log::warn!("{}", warning);
            let _ = ClaudeSessionWarningEvent {
                session_id: session_id.clone(),
                warning: warning.clone(),
            }
            .emit(&app_handle);
        }

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
            "Starting Claude session: id={}, working_dir={:?}, resume={:?}, model={:?}, claude_binary={}",
            session_id,
            working_dir,
            resume_session_id,
            resolved_model.model_id,
            claude_binary
        );

        let mut cmd = Command::new(&claude_binary);
        let vtb_gate_binary = match find_vtb_gate_binary() {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(e) => {
                log::error!("Failed to find vtb-gate: {}", e);
                let _ = ClaudeSessionErrorEvent {
                    session_id: session_id.clone(),
                    error: e,
                }
                .emit(&app_handle);
                return;
            }
        };
        let mcp_config = serde_json::json!({
            "mcpServers": {
                "vtb-gate": {
                    "command": vtb_gate_binary
                }
            }
        })
        .to_string();

        if let Some(ref resume_id) = resume_session_id {
            log::info!("Resuming Claude conversation: {}", resume_id);
        }

        let args = build_claude_args(
            &mcp_config,
            resume_session_id.as_deref(),
            resolved_model.model_id.as_deref(),
        );
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
        cmd.env("VTB_CLAUDE_SESSION_ID", &session_id);
        #[cfg(unix)]
        let _permission_socket_guard = match Self::start_permission_socket(
            &session_id,
            app_handle.clone(),
            pending_permissions.clone(),
        ) {
            Ok(socket) => {
                log::info!(
                    "Created vtb-gate permission socket for session {} at {:?}",
                    session_id,
                    socket.path()
                );
                cmd.env("VTB_GATE_SOCKET", socket.path());
                socket
            }
            Err(e) => {
                log::error!("Failed to create vtb-gate permission socket: {}", e);
                let _ = ClaudeSessionErrorEvent {
                    session_id: session_id.clone(),
                    error: e,
                }
                .emit(&app_handle);
                return;
            }
        };
        #[cfg(not(unix))]
        log::warn!("VTB_GATE_SOCKET permission transport is unavailable on this platform");

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
        Self::fail_pending_permissions_for_session(&pending_permissions, &session_id);

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

    #[cfg(unix)]
    fn start_permission_socket(
        session_id: &str,
        app_handle: tauri::AppHandle,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    ) -> Result<PermissionSocketGuard, String> {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixListener;

        let path = Self::permission_socket_path(session_id);
        let path_len = path.as_os_str().as_bytes().len();
        if path_len >= MAX_UNIX_SOCKET_PATH_BYTES {
            return Err(format!(
                "permission socket path is {path_len} bytes; must be shorter than {MAX_UNIX_SOCKET_PATH_BYTES}: {:?}",
                path
            ));
        }

        let directory = path
            .parent()
            .ok_or_else(|| format!("permission socket path has no parent: {:?}", path))?
            .to_path_buf();
        Self::prepare_permission_socket_directory(&directory)?;
        if let Err(err) = std::fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to remove stale permission socket: {err}"));
            }
        }

        let listener = UnixListener::bind(&path)
            .map_err(|err| format!("failed to bind permission socket {:?}: {err}", path))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("failed to set permission socket mode: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("failed to set permission socket nonblocking: {err}"))?;

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let session_id_for_listener = session_id.to_string();
        thread::spawn(move || {
            while !stop_for_thread.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _addr)) => {
                        let app_handle = app_handle.clone();
                        let pending_permissions = pending_permissions.clone();
                        let session_id = session_id_for_listener.clone();
                        thread::spawn(move || {
                            Self::handle_permission_socket_connection(
                                stream,
                                session_id,
                                app_handle,
                                pending_permissions,
                            );
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(25));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(err) => {
                        log::error!("vtb-gate permission socket accept failed: {}", err);
                        break;
                    }
                }
            }
        });

        Ok(PermissionSocketGuard {
            path,
            directory,
            stop,
        })
    }

    #[cfg(unix)]
    fn permission_socket_path(session_id: &str) -> std::path::PathBuf {
        use std::os::unix::ffi::OsStrExt;

        let directory_name = format!("vtbg-{}", Self::short_socket_id(session_id));
        let temp_path = std::env::temp_dir().join(&directory_name).join("p.sock");
        if temp_path.as_os_str().as_bytes().len() < MAX_UNIX_SOCKET_PATH_BYTES {
            return temp_path;
        }

        std::path::PathBuf::from("/tmp")
            .join(directory_name)
            .join("p.sock")
    }

    #[cfg(unix)]
    fn short_socket_id(session_id: &str) -> String {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for byte in session_id.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    #[cfg(unix)]
    fn prepare_permission_socket_directory(directory: &std::path::Path) -> Result<(), String> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        match std::fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "permission socket directory must not be a symlink: {:?}",
                        directory
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "permission socket directory path is not a directory: {:?}",
                        directory
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                builder.mode(0o700);
                if let Err(create_err) = builder.create(directory) {
                    if create_err.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(format!(
                            "failed to create permission socket directory {:?}: {create_err}",
                            directory
                        ));
                    }
                }
            }
            Err(err) => {
                return Err(format!(
                    "failed to inspect permission socket directory {:?}: {err}",
                    directory
                ));
            }
        }

        let metadata = std::fs::symlink_metadata(directory).map_err(|err| {
            format!(
                "failed to inspect permission socket directory {:?}: {err}",
                directory
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "permission socket directory must be a real directory: {:?}",
                directory
            ));
        }
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).map_err(|err| {
            format!(
                "failed to set permission socket directory mode {:?}: {err}",
                directory
            )
        })
    }

    #[cfg(unix)]
    fn handle_permission_socket_connection(
        mut stream: std::os::unix::net::UnixStream,
        session_id: String,
        app_handle: tauri::AppHandle,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    ) {
        if let Err(err) = stream.set_read_timeout(Some(PERMISSION_SOCKET_READ_TIMEOUT)) {
            let _ = Self::write_permission_socket_error(
                &mut stream,
                format!("failed to set permission socket read timeout: {err}"),
            );
            return;
        }
        let reader_stream = match stream.try_clone() {
            Ok(stream) => stream,
            Err(err) => {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    format!("failed to clone permission socket stream: {err}"),
                );
                return;
            }
        };
        let mut reader = std::io::BufReader::new(reader_stream);
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    "permission socket closed before a request was sent".to_string(),
                );
                return;
            }
            Ok(_) => {}
            Err(err) => {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    format!("failed to read permission socket request: {err}"),
                );
                return;
            }
        }

        let request: PermissionSocketRequest = match serde_json::from_str(line.trim_end()) {
            Ok(request) => request,
            Err(err) => {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    format!("invalid permission socket request: {err}"),
                );
                return;
            }
        };

        let (response_tx, response_rx) = std::sync::mpsc::channel();
        {
            let mut pending = match pending_permissions.lock() {
                Ok(pending) => pending,
                Err(_) => {
                    let _ = Self::write_permission_socket_error(
                        &mut stream,
                        "permission responder lock is poisoned".to_string(),
                    );
                    return;
                }
            };
            if pending.contains_key(&request.request_id) {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    format!("duplicate permission request id: {}", request.request_id),
                );
                return;
            }
            pending.insert(
                request.request_id.clone(),
                PendingPermission {
                    session_id: session_id.clone(),
                    response_tx,
                },
            );
        }

        let event = PermissionRequestEvent {
            request_id: request.request_id.clone(),
            session_id: Some(session_id),
            tool_name: request.tool_name.clone(),
            tool_use_id: request.tool_use_id,
            input: request.input,
            message: Some(format!("{} needs approval", request.tool_name)),
        };

        if let Err(err) = app_handle.emit("permission-request-event", &event) {
            if let Ok(mut pending) = pending_permissions.lock() {
                pending.remove(&request.request_id);
            }
            let _ = Self::write_permission_socket_error(
                &mut stream,
                format!("failed to emit permission request event: {err}"),
            );
            return;
        }

        match response_rx.recv() {
            Ok(decision) => match serde_json::to_string(&decision) {
                Ok(line) => {
                    let _ = stream.write_all(line.as_bytes());
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                }
                Err(err) => {
                    let _ = Self::write_permission_socket_error(
                        &mut stream,
                        format!("failed to serialize permission decision: {err}"),
                    );
                }
            },
            Err(_) => {
                let _ = Self::write_permission_socket_error(
                    &mut stream,
                    "permission request was cancelled".to_string(),
                );
            }
        }
    }

    #[cfg(unix)]
    fn write_permission_socket_error(
        stream: &mut std::os::unix::net::UnixStream,
        message: String,
    ) -> std::io::Result<()> {
        let line = serde_json::to_string(&LocalPermissionDecision {
            behavior: "deny".to_string(),
            message: Some(message),
            updated_input: None,
        })
        .map_err(std::io::Error::other)?;
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()
    }

    pub fn resolve_permission_request(
        &self,
        request_id: &str,
        decision: LocalPermissionDecision,
    ) -> Result<serde_json::Value, String> {
        let pending = {
            let mut pending = self
                .pending_permissions
                .lock()
                .map_err(|_| "permission responder lock is poisoned".to_string())?;
            pending.remove(request_id)
        }
        .ok_or_else(|| format!("Permission request not found or already resolved: {request_id}"))?;

        pending
            .response_tx
            .send(decision.clone())
            .map_err(|_| "Permission request connection is no longer available".to_string())?;
        serde_json::to_value(decision).map_err(|err| err.to_string())
    }

    fn fail_pending_permissions_for_session(
        pending_permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
        session_id: &str,
    ) {
        let pending_for_session = {
            let mut pending = match pending_permissions.lock() {
                Ok(pending) => pending,
                Err(_) => return,
            };
            let request_ids: Vec<String> = pending
                .iter()
                .filter(|(_request_id, pending)| pending.session_id == session_id)
                .map(|(request_id, _pending)| request_id.clone())
                .collect();
            request_ids
                .into_iter()
                .filter_map(|request_id| pending.remove(&request_id))
                .collect::<Vec<_>>()
        };

        for pending in pending_for_session {
            let _ = pending.response_tx.send(LocalPermissionDecision {
                behavior: "deny".to_string(),
                message: Some(
                    "Claude session ended before the permission request was resolved".to_string(),
                ),
                updated_input: None,
            });
        }
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
                        line
                    );

                    if let Ok(msg) = serde_json::from_str::<ClaudeMessage>(&line) {
                        let events = Self::build_events(session_id, msg);
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

        // Sub-agent (sidechain) messages carry their own context lineage; their
        // usage must not overwrite the main conversation's context meter, and
        // their tool calls/results nest under the spawning Task tool in the UI.
        let parent_tool_use_id = msg.parent_tool_use_id.clone();
        let is_sidechain = parent_tool_use_id.is_some();

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
                    } else if event.event_type == "message_delta" && !is_sidechain {
                        if let Some(usage) = event.usage {
                            let context_tokens = usage.input_context_tokens();
                            events.push(EmittedEvent::Usage(ClaudeSessionUsageEvent {
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
                    // mid-conversation, not only at session_end. Skip sidechain
                    // (sub-agent) turns: their context is independent of the
                    // main conversation and would make the meter lurch.
                    if let Some(usage) = message.usage.as_ref().filter(|_| !is_sidechain) {
                        let context_tokens = usage.input_context_tokens();
                        events.push(EmittedEvent::Usage(ClaudeSessionUsageEvent {
                            session_id: session_id.to_string(),
                            model: message.model.clone().unwrap_or_default(),
                            context_tokens,
                            // Backend has no per-turn context_window; fall back to the
                            // default context window. The frontend uses its own
                            // model→max lookup table as the source of truth for
                            // the displayed max.
                            context_window: DEFAULT_CONTEXT_WINDOW,
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
                                        parent_tool_use_id: parent_tool_use_id.clone(),
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

                                events.push(EmittedEvent::ToolResult(ClaudeToolResultEvent {
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

    #[test]
    fn test_supported_claude_model_catalog_uses_aliases() {
        let catalog = supported_claude_model_catalog();

        assert_eq!(catalog.default_model_id, "sonnet");
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "haiku", "fable"]
        );
    }

    #[test]
    fn test_resolve_requested_claude_model_accepts_supported_ids() {
        assert_eq!(
            resolve_requested_claude_model(Some(" Opus ".to_string()), false),
            ResolvedClaudeModel {
                model_id: Some("opus".to_string()),
                warning: None,
            }
        );
    }

    #[test]
    fn test_resolve_requested_claude_model_omits_blank_selection() {
        assert_eq!(
            resolve_requested_claude_model(Some("   ".to_string()), false),
            ResolvedClaudeModel {
                model_id: None,
                warning: None,
            }
        );
    }

    #[test]
    fn test_resolve_requested_claude_model_falls_back_with_warning() {
        let resolved = resolve_requested_claude_model(Some("claude-unknown".to_string()), false);

        assert_eq!(resolved.model_id.as_deref(), Some("sonnet"));
        assert!(resolved
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("claude-unknown")));
    }

    #[test]
    fn test_resolve_requested_claude_model_escapes_warning_id() {
        let resolved =
            resolve_requested_claude_model(Some("Mystery\nINFO fake".to_string()), false);

        assert_eq!(resolved.model_id.as_deref(), Some("sonnet"));
        assert!(resolved
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("mystery\\ninfo fake")));
    }

    #[test]
    fn test_resolve_requested_claude_model_omits_unsupported_model_on_resume() {
        let resolved = resolve_requested_claude_model(Some("retired".to_string()), true);

        assert_eq!(resolved.model_id, None);
        assert!(resolved
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("original model")));
    }

    #[test]
    fn test_build_claude_args_without_model_matches_existing_defaults() {
        let args = build_claude_args("{\"mcpServers\":{}}", None, None);

        assert_eq!(
            args,
            vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--input-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--include-partial-messages".to_string(),
                "--mcp-config".to_string(),
                "{\"mcpServers\":{}}".to_string(),
                "--permission-prompt-tool".to_string(),
                "mcp__vtb-gate__permission_prompt".to_string(),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "--model"));
    }

    #[test]
    fn test_build_claude_args_includes_selected_model() {
        let args = build_claude_args("{}", None, Some("opus"));

        let model_idx = args
            .iter()
            .position(|arg| arg == "--model")
            .expect("--model should be present");
        assert_eq!(args.get(model_idx + 1).map(String::as_str), Some("opus"));
    }

    #[test]
    fn test_build_claude_args_keeps_resume_and_model_when_override_is_explicit() {
        let args = build_claude_args("{}", Some("conv-123"), Some("haiku"));

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"haiku".to_string()));
        assert!(args.contains(&"--resume=conv-123".to_string()));
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
            parent_tool_use_id: None,
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

    #[test]
    fn test_resolve_permission_request_sends_local_decision() {
        let manager = ClaudeSessionManager::new();
        let (response_tx, response_rx) = std::sync::mpsc::channel();
        manager.pending_permissions.lock().unwrap().insert(
            "req-1".to_string(),
            PendingPermission {
                session_id: "session-1".to_string(),
                response_tx,
            },
        );

        let result = manager
            .resolve_permission_request(
                "req-1",
                LocalPermissionDecision {
                    behavior: "allow".to_string(),
                    message: None,
                    updated_input: Some(serde_json::json!({ "command": "ls" })),
                },
            )
            .unwrap();

        assert_eq!(result["behavior"], "allow");
        assert!(manager.pending_permissions.lock().unwrap().is_empty());

        let decision = response_rx.recv().unwrap();
        assert_eq!(decision.behavior, "allow");
        assert_eq!(
            decision.updated_input,
            Some(serde_json::json!({ "command": "ls" }))
        );
    }

    #[test]
    fn test_resolve_permission_request_requires_local_pending_request() {
        let manager = ClaudeSessionManager::new();
        let result = manager.resolve_permission_request(
            "missing",
            LocalPermissionDecision {
                behavior: "deny".to_string(),
                message: Some("Denied".to_string()),
                updated_input: None,
            },
        );

        assert!(result.unwrap_err().contains("Permission request not found"));
    }

    #[test]
    fn test_fail_pending_permissions_for_session_sends_denials() {
        let pending_permissions = Arc::new(Mutex::new(HashMap::new()));
        let (session_a_tx_1, session_a_rx_1) = std::sync::mpsc::channel();
        let (session_a_tx_2, session_a_rx_2) = std::sync::mpsc::channel();
        let (session_b_tx, session_b_rx) = std::sync::mpsc::channel();

        {
            let mut pending = pending_permissions.lock().unwrap();
            pending.insert(
                "req-a-1".to_string(),
                PendingPermission {
                    session_id: "session-a".to_string(),
                    response_tx: session_a_tx_1,
                },
            );
            pending.insert(
                "req-a-2".to_string(),
                PendingPermission {
                    session_id: "session-a".to_string(),
                    response_tx: session_a_tx_2,
                },
            );
            pending.insert(
                "req-b".to_string(),
                PendingPermission {
                    session_id: "session-b".to_string(),
                    response_tx: session_b_tx,
                },
            );
        }

        ClaudeSessionManager::fail_pending_permissions_for_session(
            &pending_permissions,
            "session-a",
        );

        for receiver in [session_a_rx_1, session_a_rx_2] {
            let decision = receiver
                .recv_timeout(std::time::Duration::from_millis(100))
                .unwrap();
            assert_eq!(decision.behavior, "deny");
            assert_eq!(
                decision.message.as_deref(),
                Some("Claude session ended before the permission request was resolved")
            );
            assert!(decision.updated_input.is_none());
        }
        assert!(matches!(
            session_b_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));

        let pending = pending_permissions.lock().unwrap();
        assert!(!pending.contains_key("req-a-1"));
        assert!(!pending.contains_key("req-a-2"));
        assert!(pending.contains_key("req-b"));
    }

    #[test]
    fn test_local_permission_decision_serializes_for_claude_schema() {
        let allow = serde_json::to_value(LocalPermissionDecision {
            behavior: "allow".to_string(),
            message: None,
            updated_input: Some(serde_json::json!({ "command": "ls" })),
        })
        .unwrap();
        assert_eq!(
            allow,
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": { "command": "ls" }
            })
        );

        let deny = serde_json::to_value(LocalPermissionDecision {
            behavior: "deny".to_string(),
            message: Some("Denied from Vertebrae GUI".to_string()),
            updated_input: None,
        })
        .unwrap();
        assert_eq!(
            deny,
            serde_json::json!({
                "behavior": "deny",
                "message": "Denied from Vertebrae GUI"
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_prepare_permission_socket_directory_sets_private_mode() {
        use std::os::unix::fs::PermissionsExt;

        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("vtbg-dir-test-{}-{suffix}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);

        ClaudeSessionManager::prepare_permission_socket_directory(&directory).unwrap();

        let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);

        std::fs::remove_dir(&directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_permission_socket_path_stays_under_unix_limit_for_long_session_ids() {
        use std::os::unix::ffi::OsStrExt;

        let session_id =
            "scoped-chat-1781971607649-bijgbrn-1781971734050-extra-long-session-suffix";
        let path = ClaudeSessionManager::permission_socket_path(session_id);
        let path_len = path.as_os_str().as_bytes().len();

        assert!(
            path_len < MAX_UNIX_SOCKET_PATH_BYTES,
            "socket path should fit Unix sockaddr limits: {:?} ({path_len} bytes)",
            path
        );
        assert!(
            !path.to_string_lossy().contains(session_id),
            "socket path should not embed the raw session id"
        );
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
    fn test_build_events_assistant_emits_usage_event() {
        // Per-turn usage event should fire whenever the assistant message
        // carries a `usage` block. Cached input tokens still occupy the
        // request context, so they are included in the context-size figure.
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-opus-4-7-20250115",
                    "content": [{"type": "text", "text": "hi"}],
                    "usage": {
                        "input_tokens": 50,
                        "cache_read_input_tokens": 100000,
                        "cache_creation_input_tokens": 0,
                        "output_tokens": 25
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
                assert_eq!(e.context_tokens, 100_050);
                assert_eq!(e.context_window, 200_000);
            }
            other => panic!("Expected Usage event first, got {:?}", other),
        }
        assert!(matches!(&events[1], EmittedEvent::Text(_)));
    }

    #[test]
    fn test_build_events_assistant_usage_includes_cache_creation_tokens() {
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet-4-6-latest",
                    "content": [{"type": "text", "text": "hi"}],
                    "usage": {
                        "input_tokens": 10,
                        "cache_read_input_tokens": 30,
                        "cache_creation_input_tokens": 40,
                        "output_tokens": 20
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 2, "expected Usage + Text events");
        match &events[0] {
            EmittedEvent::Usage(e) => {
                assert_eq!(e.model, "claude-sonnet-4-6-latest");
                assert_eq!(e.context_tokens, 80);
                assert_eq!(e.context_window, 200_000);
            }
            other => panic!("Expected Usage event first, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_assistant_sidechain_usage_is_skipped() {
        // Sub-agent (sidechain) messages carry `parent_tool_use_id` and run
        // with their own context lineage. Their usage must NOT emit a context
        // event, or the meter lurches to the sub-agent's (often much smaller,
        // cache-cold) context size mid-turn.
        let msg = parse_msg(
            r#"{
                "type": "assistant",
                "parent_tool_use_id": "toolu_015MUSNfZRk8PAxfmiznzBxt",
                "message": {
                    "role": "assistant",
                    "model": "claude-haiku-4-5-20251001",
                    "content": [{"type": "text", "text": "searching"}],
                    "usage": {
                        "input_tokens": 3,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 8415,
                        "output_tokens": 12
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        assert_eq!(events.len(), 1, "sidechain usage must not be emitted");
        assert!(
            matches!(&events[0], EmittedEvent::Text(_)),
            "expected only the Text event, got {:?}",
            events[0]
        );
    }

    #[test]
    fn test_build_events_propagates_parent_tool_use_id() {
        // A sub-agent tool call carries parent_tool_use_id so the UI can nest it
        // under the spawning Task tool. Main-thread calls carry None.
        let sidechain = parse_msg(
            r#"{
                "type": "assistant",
                "parent_tool_use_id": "toolu_AGENT",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "toolu_child", "name": "Read", "input": {}}]
                }
            }"#,
        );
        let events = ClaudeSessionManager::build_events("s", sidechain);
        match events
            .iter()
            .find(|e| matches!(e, EmittedEvent::ToolCall(_)))
        {
            Some(EmittedEvent::ToolCall(e)) => {
                assert_eq!(e.parent_tool_use_id.as_deref(), Some("toolu_AGENT"));
            }
            _ => panic!("expected ToolCall event"),
        }

        let main = parse_msg(
            r#"{
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "toolu_main", "name": "Read", "input": {}}]
                }
            }"#,
        );
        match ClaudeSessionManager::build_events("s", main)
            .into_iter()
            .find(|e| matches!(e, EmittedEvent::ToolCall(_)))
        {
            Some(EmittedEvent::ToolCall(e)) => assert_eq!(e.parent_tool_use_id, None),
            _ => panic!("expected ToolCall event"),
        }

        // tool_result on a sidechain user message carries the parent too.
        let result = parse_msg(
            r#"{
                "type": "user",
                "parent_tool_use_id": "toolu_AGENT",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_child", "content": "ok", "is_error": false}]
                }
            }"#,
        );
        match ClaudeSessionManager::build_events("s", result)
            .into_iter()
            .find(|e| matches!(e, EmittedEvent::ToolResult(_)))
        {
            Some(EmittedEvent::ToolResult(e)) => {
                assert_eq!(e.parent_tool_use_id.as_deref(), Some("toolu_AGENT"))
            }
            _ => panic!("expected ToolResult event"),
        }
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
                // modelUsage is a cumulative session summary, not a usable
                // point-in-time context size, so SessionEnd reports 0 tokens
                // and only surfaces the model's context window.
                assert_eq!(e.context_tokens, 0);
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
    fn test_build_events_result_reports_window_not_cumulative_tokens() {
        // modelUsage token counts are cumulative session totals, not a
        // point-in-time context size, so SessionEnd never derives
        // context_tokens from them — it stays 0 and only the window is carried.
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
                assert_eq!(e.context_tokens, 0);
                assert_eq!(e.context_window, 100_000);
            }
            other => panic!("Expected SessionEnd event, got {:?}", other),
        }
    }

    #[test]
    fn test_build_events_result_picks_largest_context_window_deterministically() {
        // With multiple models in modelUsage, the largest reported window wins
        // (deterministic regardless of HashMap order); context_tokens stays 0.
        let msg = parse_msg(
            r#"{
                "type": "result",
                "modelUsage": {
                    "model-a": {
                        "inputTokens": 10,
                        "outputTokens": 999,
                        "cacheReadInputTokens": 20,
                        "cacheCreationInputTokens": 30,
                        "contextWindow": 200000
                    },
                    "model-b": {
                        "inputTokens": 100,
                        "outputTokens": 999,
                        "cacheReadInputTokens": 200,
                        "cacheCreationInputTokens": 300,
                        "contextWindow": 1000000
                    }
                }
            }"#,
        );

        let events = ClaudeSessionManager::build_events("sess-1", msg);
        match &events[0] {
            EmittedEvent::SessionEnd(e) => {
                assert_eq!(e.context_tokens, 0);
                assert_eq!(e.context_window, 1_000_000);
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
    fn test_build_augmented_path_contains_local_bin() {
        let path = build_augmented_path();
        let home = dirs::home_dir().expect("test requires HOME to be set");
        let local_bin = home.join(".local").join("bin");
        let local_bin_str = local_bin.to_string_lossy();

        assert!(
            path.contains(&*local_bin_str),
            "PATH should contain {}, got: {}",
            local_bin_str,
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
        // At minimum: ~/.cargo/bin, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin
        assert!(
            segments.len() >= 4,
            "PATH should have at least 4 segments, got {}: {}",
            segments.len(),
            path
        );
    }
}
