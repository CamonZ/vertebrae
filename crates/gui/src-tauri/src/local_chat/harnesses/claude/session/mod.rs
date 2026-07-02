//! Claude CLI session runtime with JSONL streaming
//!
//! Harness-private runtime that owns the live Claude process registry and
//! translates JSONL stream events into neutral [`LocalChatEvent`] payloads.

#![allow(dead_code)] // Some fields are parsed but not yet used

use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::commands::AppState;
use crate::helpers::{build_augmented_path, find_claude_binary, find_vtb_gate_binary};
use crate::local_chat::harnesses::claude::args::{
    build_claude_args, resolve_requested_claude_model,
};
use crate::local_chat::harnesses::claude::jsonl::{self, EmittedEvent};
use crate::local_chat::harnesses::claude::live_jsonl::{
    encode_claude_user_jsonl_message, process_claude_stderr_lines, ClaudeLiveJsonlCommand,
    ClaudeLiveJsonlProcessError, ClaudeLiveJsonlProcessRunner,
};
use crate::local_chat::permissions::PermissionBridge;
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionEndEvent as NeutralSessionEndEvent, LocalChatSessionError,
    LocalChatSessionErrorEvent as NeutralSessionErrorEvent,
    LocalChatSessionInitEvent as NeutralSessionInitEvent,
    LocalChatSessionUsageEvent as NeutralSessionUsageEvent,
    LocalChatSessionWarningEvent as NeutralSessionWarningEvent,
    LocalChatTextEvent as NeutralTextEvent, LocalChatToolCallEvent as NeutralToolCallEvent,
    LocalChatToolResultEvent as NeutralToolResultEvent,
};

/// Truncate a string to at most `max_bytes` bytes without splitting a multi-byte UTF-8 character.
fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
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
// Session runtime
// ============================================================================

struct SessionHandle {
    command_tx: mpsc::UnboundedSender<ClaudeLiveJsonlCommand>,
}

struct SessionRuntimeState {
    runtime: LocalChatRuntime,
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
}

struct SessionCleanup {
    session_id: String,
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
    permission_bridge: PermissionBridge,
}

impl SessionCleanup {
    fn new(
        session_id: String,
        sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
        permission_bridge: PermissionBridge,
    ) -> Self {
        Self {
            session_id,
            sessions,
            permission_bridge,
        }
    }
}

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        self.permission_bridge.fail_pending_permissions_for_session(
            &self.session_id,
            "Claude session ended before the permission request was resolved",
        );
        let mut sessions = self.sessions.blocking_write();
        sessions.remove(&self.session_id);
    }
}

/// Harness-private runtime that manages active Claude CLI sessions.
#[derive(Clone)]
pub(crate) struct ClaudeSessionRuntime {
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
}

impl ClaudeSessionRuntime {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let session_id = input.backend_session_id.clone();
        if runtime.app_handle().is_none() {
            return Err(LocalChatSessionError::SpawnFailed(
                "Tauri app handle is required to start a Claude session".to_string(),
            ));
        }
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(&session_id) {
                return Err(LocalChatSessionError::SessionExists(session_id));
            }
        }

        let (command_tx, command_rx) = mpsc::unbounded_channel();

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), SessionHandle { command_tx });
        }

        let runtime_state = SessionRuntimeState {
            runtime,
            sessions: self.sessions.clone(),
        };
        thread::spawn(move || {
            Self::run_session(input, command_rx, runtime_state);
        });

        log::info!("Claude session {} created", session_id);
        Ok(())
    }

    fn run_session(
        input: HarnessCreateSessionInput,
        command_rx: mpsc::UnboundedReceiver<ClaudeLiveJsonlCommand>,
        runtime_state: SessionRuntimeState,
    ) {
        let HarnessCreateSessionInput {
            backend_session_id: session_id,
            working_dir,
            initial_prompt,
            provider_resume_id: resume_session_id,
            model_id: requested_model_id,
            permission_mode,
            ..
        } = input;
        let SessionRuntimeState { runtime, sessions } = runtime_state;
        let Some(app_handle) = runtime.app_handle() else {
            log::error!("Cannot run Claude session without a Tauri app handle");
            return;
        };
        let event_sink = runtime.event_sink();
        let permission_bridge = runtime.permission_bridge();
        let cleanup_guard =
            SessionCleanup::new(session_id.clone(), sessions, permission_bridge.clone());
        let Some(working_dir) = resolve_working_dir(working_dir, &app_handle) else {
            let error = "Cannot start Claude session without a selected project path".to_string();
            log::error!("{}", error);
            Self::emit_error(&event_sink, &session_id, error);
            return;
        };

        let resolved_model =
            resolve_requested_claude_model(requested_model_id, resume_session_id.is_some());
        if let Some(warning) = &resolved_model.warning {
            log::warn!("{}", warning);
            Self::emit_warning(&event_sink, &session_id, warning.clone());
        }

        let claude_binary = match find_claude_binary() {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(e) => {
                log::error!("Failed to find Claude Code CLI: {}", e);
                Self::emit_init(&event_sink, &session_id, None, String::new(), vec![]);
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
                Self::emit_error(&event_sink, &session_id, e);
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
            Self::emit_error(&event_sink, &session_id, error);
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
        let _permission_socket_guard =
            match permission_bridge.start_socket(&session_id, app_handle.clone()) {
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
                    Self::emit_error(&event_sink, &session_id, e);
                    return;
                }
            };
        #[cfg(not(unix))]
        log::warn!("VTB_GATE_SOCKET permission transport is unavailable on this platform");

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let event_sink_for_reader = event_sink.clone();
        let stdout_processor = Box::new(move |reader, session_id: String| {
            jsonl::process_jsonl_lines(reader, &session_id, |events| {
                Self::emit_jsonl_events(&event_sink_for_reader, events);
            });
        });

        let event_sink_for_stderr = event_sink.clone();
        let stderr_processor = Box::new(move |reader, session_id: String| {
            process_claude_stderr_lines(reader, &session_id, |error_msg| {
                Self::emit_error(&event_sink_for_stderr, &session_id, error_msg);
            });
        });

        let runner = ClaudeLiveJsonlProcessRunner::new(
            session_id.clone(),
            cmd,
            command_rx,
            Box::new(encode_claude_user_jsonl_message),
            stdout_processor,
            stderr_processor,
        )
        .with_initial_prompt(initial_prompt);

        match runner.run() {
            Ok(result) => {
                log::debug!(
                    "Claude session {} live JSONL runner exited via {:?}, status={:?}",
                    session_id,
                    result.exit_reason,
                    result.wait_status
                );
            }
            Err(ClaudeLiveJsonlProcessError::Spawn(err)) => {
                let error = format!("Failed to spawn claude at {}: {}", claude_binary, err);
                log::error!("{}", error);
                Self::emit_error(&event_sink, &session_id, error);
                return;
            }
            Err(err) => {
                let error = err.to_string();
                log::error!("{}", error);
                Self::emit_error(&event_sink, &session_id, error);
                return;
            }
        }

        drop(cleanup_guard);
        log::info!("Claude session {} ended", session_id);
    }

    fn emit_jsonl_events(event_sink: &LocalChatEventSink, events: Vec<EmittedEvent>) {
        for event in events {
            let event = Self::local_chat_event_from_claude_emitted(event);
            if let LocalChatEvent::Init(e) = &event {
                log::info!(
                    "[Claude Init] conversation_id={:?}, model={}",
                    e.provider_resume_id,
                    e.model
                );
            }
            event_sink.emit(event);
        }
    }

    fn local_chat_event_from_claude_emitted(event: EmittedEvent) -> LocalChatEvent {
        match event {
            EmittedEvent::Init(e) => LocalChatEvent::Init(NeutralSessionInitEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                provider_resume_id: e.claude_conversation_id,
                model: e.model,
                tools: e.tools,
            }),
            EmittedEvent::Text(e) => LocalChatEvent::Text(NeutralTextEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                text: e.text,
                is_partial: e.is_partial,
                parent_tool_use_id: e.parent_tool_use_id,
            }),
            EmittedEvent::ToolCall(e) => LocalChatEvent::ToolCall(NeutralToolCallEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                tool_id: e.tool_id,
                tool_name: e.tool_name,
                input: e.input,
                parent_tool_use_id: e.parent_tool_use_id,
            }),
            EmittedEvent::ToolResult(e) => LocalChatEvent::ToolResult(NeutralToolResultEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                tool_id: e.tool_id,
                result: e.result,
                is_error: e.is_error,
                parent_tool_use_id: e.parent_tool_use_id,
            }),
            EmittedEvent::Usage(e) => LocalChatEvent::Usage(NeutralSessionUsageEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                model: e.model,
                context_tokens: e.context_tokens,
                context_window: e.context_window,
            }),
            EmittedEvent::SessionEnd(e) => LocalChatEvent::End(NeutralSessionEndEvent {
                backend_session_id: e.session_id,
                harness: LocalChatHarnessKind::Claude,
                duration_ms: e.duration_ms,
                cost_usd: e.cost_usd,
                num_turns: e.num_turns,
                result: e.result,
                is_error: e.is_error,
                context_tokens: e.context_tokens,
                context_window: e.context_window,
            }),
        }
    }

    fn emit_init(
        event_sink: &LocalChatEventSink,
        session_id: &str,
        provider_resume_id: Option<String>,
        model: String,
        tools: Vec<String>,
    ) {
        event_sink.emit(LocalChatEvent::Init(NeutralSessionInitEvent {
            backend_session_id: session_id.to_string(),
            harness: LocalChatHarnessKind::Claude,
            provider_resume_id,
            model,
            tools,
        }));
    }

    fn emit_error(event_sink: &LocalChatEventSink, session_id: &str, error: String) {
        event_sink.emit(LocalChatEvent::Error(NeutralSessionErrorEvent {
            backend_session_id: session_id.to_string(),
            harness: LocalChatHarnessKind::Claude,
            error,
        }));
    }

    fn emit_warning(event_sink: &LocalChatEventSink, session_id: &str, warning: String) {
        event_sink.emit(LocalChatEvent::Warning(NeutralSessionWarningEvent {
            backend_session_id: session_id.to_string(),
            harness: LocalChatHarnessKind::Claude,
            warning,
        }));
    }

    /// Process stderr lines from the Claude CLI.
    fn process_stderr_lines(reader: impl BufRead, session_id: &str, on_error: impl FnMut(String)) {
        process_claude_stderr_lines(reader, session_id, on_error);
    }

    pub(crate) async fn send_message(
        &self,
        session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(ClaudeLiveJsonlCommand::SendMessage {
                content: content.to_string(),
                response: response_tx,
            })
            .map_err(|_| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| LocalChatSessionError::SendFailed("Session closed".to_string()))?
            .map_err(LocalChatSessionError::SendFailed)
    }

    pub(crate) async fn close_session(
        &self,
        session_id: &str,
    ) -> Result<(), LocalChatSessionError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(ClaudeLiveJsonlCommand::Close {
                response: response_tx,
            })
            .map_err(|_| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| LocalChatSessionError::SessionNotFound("Session closed".to_string()))?
            .map_err(LocalChatSessionError::SessionNotFound)
    }

    pub(crate) async fn has_session(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        sessions.contains_key(session_id)
    }
}

impl Default for ClaudeSessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod line_processing_tests;
#[cfg(test)]
mod local_chat_event_mapping_tests;
#[cfg(test)]
mod manager_session_registry_tests;
#[cfg(test)]
mod path_utilities_tests;
