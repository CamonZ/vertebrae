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
use tauri::{Emitter, Manager};
use tauri_specta::Event;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::commands::AppState;
use crate::events::PermissionRequestEvent;
use crate::helpers::{find_claude_binary, find_vtb_gate_binary};
use crate::local_chat::harnesses::claude::args::{
    build_claude_args, resolve_requested_claude_model,
};
pub use crate::local_chat::harnesses::claude::args::{
    supported_claude_model_catalog, ClaudeModelCatalog, ClaudeModelOption,
};
use crate::local_chat::harnesses::claude::jsonl::{self, EmittedEvent};
use crate::types::CreateClaudeSessionInput;

#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;
#[cfg(unix)]
const PERMISSION_SOCKET_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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

fn current_project_path<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<String> {
    let state = app_handle.try_state::<AppState>()?;
    let slug = state.project_config.get_current_project()?;
    match vertebrae_sacrum_client::load_config_file() {
        Ok(config) => config
            .projects
            .get(&slug)
            .map(|project| project.path.clone()),
        Err(err) => {
            log::warn!(
                "Failed to load config while resolving current project path: {}",
                err
            );
            None
        }
    }
}

fn resolve_working_dir<R: tauri::Runtime>(
    working_dir: Option<String>,
    app_handle: &tauri::AppHandle<R>,
) -> Option<String> {
    working_dir
        .filter(|dir| !dir.trim().is_empty())
        .or_else(|| current_project_path(app_handle))
        .filter(|dir| !dir.trim().is_empty())
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
        input: CreateClaudeSessionInput,
        app_handle: tauri::AppHandle,
    ) -> Result<(), ClaudeSessionError> {
        let session_id = input.session_id.clone();
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
        thread::spawn(move || {
            Self::run_session(input, command_rx, runtime_state);
        });

        log::info!("Claude session {} created", session_id);
        Ok(())
    }

    /// Run the Claude CLI session in a dedicated thread
    fn run_session(
        input: CreateClaudeSessionInput,
        mut command_rx: mpsc::UnboundedReceiver<SessionCommand>,
        runtime_state: SessionRuntimeState,
    ) {
        let CreateClaudeSessionInput {
            session_id,
            working_dir,
            initial_prompt,
            resume_session_id,
            model_id: requested_model_id,
            permission_mode,
        } = input;
        let SessionRuntimeState {
            app_handle,
            sessions,
            pending_permissions,
        } = runtime_state;
        let Some(working_dir) = resolve_working_dir(working_dir, &app_handle) else {
            let error = "Cannot start Claude session without a selected project path".to_string();
            log::error!("{}", error);
            let _ = ClaudeSessionErrorEvent {
                session_id: session_id.clone(),
                error,
            }
            .emit(&app_handle);
            return;
        };

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
            Some(&working_dir),
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
            permission_mode,
        );
        cmd.args(&args);

        let path = std::path::Path::new(&working_dir);
        if path.exists() && path.is_dir() {
            log::info!("Setting working directory to: {}", working_dir);
            cmd.current_dir(&working_dir);
        } else {
            let error = format!(
                "Working directory does not exist or is not a directory: {}",
                working_dir
            );
            log::error!("{}", error);
            let _ = ClaudeSessionErrorEvent {
                session_id: session_id.clone(),
                error,
            }
            .emit(&app_handle);
            return;
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
            jsonl::process_jsonl_lines(reader, &session_id_for_reader, |events| {
                for event in events {
                    match event {
                        EmittedEvent::Init(e) => {
                            let event = ClaudeSessionInitEvent {
                                session_id: e.session_id,
                                claude_conversation_id: e.claude_conversation_id,
                                model: e.model,
                                tools: e.tools,
                            };
                            log::info!(
                                "[Claude Init] conversation_id={:?}, model={}",
                                event.claude_conversation_id,
                                event.model
                            );
                            let _ = event.emit(&app_handle_for_reader);
                        }
                        EmittedEvent::Text(e) => {
                            let _ = ClaudeTextEvent {
                                session_id: e.session_id,
                                text: e.text,
                                is_partial: e.is_partial,
                            }
                            .emit(&app_handle_for_reader);
                        }
                        EmittedEvent::ToolCall(e) => {
                            let _ = ClaudeToolCallEvent {
                                session_id: e.session_id,
                                tool_id: e.tool_id,
                                tool_name: e.tool_name,
                                input: e.input,
                                parent_tool_use_id: e.parent_tool_use_id,
                            }
                            .emit(&app_handle_for_reader);
                        }
                        EmittedEvent::ToolResult(e) => {
                            let _ = ClaudeToolResultEvent {
                                session_id: e.session_id,
                                tool_id: e.tool_id,
                                result: e.result,
                                is_error: e.is_error,
                                parent_tool_use_id: e.parent_tool_use_id,
                            }
                            .emit(&app_handle_for_reader);
                        }
                        EmittedEvent::Usage(e) => {
                            let _ = ClaudeSessionUsageEvent {
                                session_id: e.session_id,
                                model: e.model,
                                context_tokens: e.context_tokens,
                                context_window: e.context_window,
                            }
                            .emit(&app_handle_for_reader);
                        }
                        EmittedEvent::SessionEnd(e) => {
                            let _ = ClaudeSessionEndEvent {
                                session_id: e.session_id,
                                duration_ms: e.duration_ms,
                                cost_usd: e.cost_usd,
                                num_turns: e.num_turns,
                                result: e.result,
                                is_error: e.is_error,
                                context_tokens: e.context_tokens,
                                context_window: e.context_window,
                            }
                            .emit(&app_handle_for_reader);
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
mod line_processing_tests;
#[cfg(test)]
mod manager_session_registry_tests;
#[cfg(test)]
mod path_utilities_tests;
#[cfg(test)]
mod permission_bridge_tests;
