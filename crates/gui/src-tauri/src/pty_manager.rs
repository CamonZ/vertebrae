//! PTY management for terminal emulation
//!
//! Provides PTY-based terminal sessions for running Claude CLI with full
//! terminal capabilities including ANSI escape sequences and interactive I/O.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use tauri_specta::Event;
use tokio::sync::{mpsc, oneshot, RwLock};

/// Event emitted when PTY produces output
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PtyOutputEvent {
    pub session_id: String,
    /// Raw output bytes encoded as base64 to preserve binary data
    pub data: String,
}

/// Event emitted when PTY session ends
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PtyExitEvent {
    pub session_id: String,
    /// Exit code if process exited normally
    pub exit_code: Option<i32>,
    /// Error message if process failed
    pub error: Option<String>,
}

/// Commands sent to PTY session threads
enum PtyCommand {
    Write {
        data: Vec<u8>,
        response: oneshot::Sender<Result<(), String>>,
    },
    Resize {
        cols: u16,
        rows: u16,
        response: oneshot::Sender<Result<(), String>>,
    },
    Close {
        response: oneshot::Sender<Result<(), String>>,
    },
}

/// Handle to a PTY session for sending commands
struct SessionHandle {
    command_tx: mpsc::UnboundedSender<PtyCommand>,
}

/// Manages active PTY sessions
pub struct PtyManager {
    sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
}

impl PtyManager {
    /// Create a new PTY manager
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Spawn a new shell PTY session
    pub async fn spawn_shell_pty(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        working_dir: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), PtyError> {
        // Create command channel
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        // Store session handle
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), SessionHandle { command_tx });
        }

        // Spawn the PTY thread
        let sessions = self.sessions.clone();
        let session_id_clone = session_id.clone();
        thread::spawn(move || {
            Self::run_pty_session(
                session_id_clone,
                cols,
                rows,
                working_dir,
                command_rx,
                app_handle,
                sessions,
            );
        });

        log::info!("PTY session {} spawn initiated", session_id);
        Ok(())
    }

    /// Run the PTY session in a dedicated thread
    fn run_pty_session(
        session_id: String,
        cols: u16,
        rows: u16,
        working_dir: Option<String>,
        mut command_rx: mpsc::UnboundedReceiver<PtyCommand>,
        app_handle: tauri::AppHandle,
        sessions: Arc<RwLock<HashMap<String, SessionHandle>>>,
    ) {
        use base64::Engine;
        let encoder = base64::engine::general_purpose::STANDARD;

        // Create PTY
        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(e) => {
                log::error!("Failed to create PTY: {}", e);
                let _ = PtyExitEvent {
                    session_id: session_id.clone(),
                    exit_code: None,
                    error: Some(format!("Failed to create PTY: {}", e)),
                }
                .emit(&app_handle);
                return;
            }
        };

        // Build command - use user's default shell
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        // Start as login shell for proper environment
        cmd.args(["-l"]);
        if let Some(dir) = working_dir {
            cmd.cwd(dir);
        }

        // Spawn process
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                log::error!("Failed to spawn command: {}", e);
                let _ = PtyExitEvent {
                    session_id: session_id.clone(),
                    exit_code: None,
                    error: Some(format!("Failed to spawn command: {}", e)),
                }
                .emit(&app_handle);
                return;
            }
        };

        // Get reader and writer
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                log::error!("Failed to get PTY reader: {}", e);
                let _ = PtyExitEvent {
                    session_id: session_id.clone(),
                    exit_code: None,
                    error: Some(format!("Failed to get PTY reader: {}", e)),
                }
                .emit(&app_handle);
                return;
            }
        };

        // Get writer from master
        let mut writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to get PTY writer: {}", e);
                let _ = PtyExitEvent {
                    session_id: session_id.clone(),
                    exit_code: None,
                    error: Some(format!("Failed to get PTY writer: {}", e)),
                }
                .emit(&app_handle);
                return;
            }
        };

        let master = pair.master;
        log::info!("PTY session {} started", session_id);

        // Spawn reader thread
        let session_id_for_reader = session_id.clone();
        let app_handle_for_reader = app_handle.clone();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        log::info!("PTY session {} EOF", session_id_for_reader);
                        let _ = exit_tx.send(());
                        break;
                    }
                    Ok(n) => {
                        let data = encoder.encode(&buf[..n]);
                        let _ = PtyOutputEvent {
                            session_id: session_id_for_reader.clone(),
                            data,
                        }
                        .emit(&app_handle_for_reader);
                    }
                    Err(e) => {
                        // Check for interrupted error which is common during resize/close
                        if e.kind() != std::io::ErrorKind::Interrupted {
                            log::error!("PTY read error: {}", e);
                        }
                        let _ = exit_tx.send(());
                        break;
                    }
                }
            }
        });

        // Process commands using std::sync::mpsc to avoid async in thread
        let (sync_tx, sync_rx) = std::sync::mpsc::channel::<PtyCommand>();

        // Forward from tokio channel to sync channel in a separate task
        let session_id_for_forwarder = session_id.clone();
        std::thread::spawn(move || {
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
                "PTY session {} command forwarder exited",
                session_id_for_forwarder
            );
        });

        // Main command processing loop
        let mut should_exit = false;

        loop {
            // Check for commands with a short timeout
            match sync_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(cmd) => match cmd {
                    PtyCommand::Write { data, response } => {
                        let result = writer
                            .write_all(&data)
                            .map_err(|e: std::io::Error| e.to_string())
                            .and_then(|_| {
                                writer.flush().map_err(|e: std::io::Error| e.to_string())
                            });
                        let _ = response.send(result);
                    }
                    PtyCommand::Resize {
                        cols,
                        rows,
                        response,
                    } => {
                        let result = master
                            .resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .map_err(|e| e.to_string());
                        let _ = response.send(result);
                    }
                    PtyCommand::Close { response } => {
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
        let exit_status = child.wait();
        let exit_code = exit_status
            .ok()
            .map(|s| if s.success() { 0 } else { s.exit_code() as i32 });

        // Emit exit event
        let _ = PtyExitEvent {
            session_id: session_id.clone(),
            exit_code,
            error: None,
        }
        .emit(&app_handle);

        // Clean up session
        let session_id_for_cleanup = session_id.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let mut sessions = sessions.write().await;
                sessions.remove(&session_id_for_cleanup);
            });
        });

        log::info!("PTY session {} ended", session_id);
    }

    /// Write data to a PTY session
    pub async fn write_to_pty(&self, session_id: &str, data: &[u8]) -> Result<(), PtyError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(PtyCommand::Write {
                data: data.to_vec(),
                response: response_tx,
            })
            .map_err(|_| PtyError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| PtyError::WriteFailed("Session closed".to_string()))?
            .map_err(PtyError::WriteFailed)
    }

    /// Resize a PTY session
    pub async fn resize_pty(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(PtyCommand::Resize {
                cols,
                rows,
                response: response_tx,
            })
            .map_err(|_| PtyError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| PtyError::ResizeFailed("Session closed".to_string()))?
            .map_err(PtyError::ResizeFailed)
    }

    /// Close a PTY session
    pub async fn close_session(&self, session_id: &str) -> Result<(), PtyError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

        let (response_tx, response_rx) = oneshot::channel();
        session
            .command_tx
            .send(PtyCommand::Close {
                response: response_tx,
            })
            .map_err(|_| PtyError::SessionNotFound(session_id.to_string()))?;

        response_rx
            .await
            .map_err(|_| PtyError::SessionNotFound("Session closed".to_string()))?
            .map_err(PtyError::SessionNotFound)
    }

    /// Check if a session exists
    pub async fn has_session(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        sessions.contains_key(session_id)
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// PTY operation errors
#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
pub enum PtyError {
    #[error("Failed to spawn PTY: {0}")]
    SpawnFailed(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to write to PTY: {0}")]
    WriteFailed(String),
    #[error("Failed to resize PTY: {0}")]
    ResizeFailed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================================
    // Initialization and Creation Tests
    // ============================================================================

    #[test]
    fn test_pty_manager_new() {
        let manager = PtyManager::new();
        // Should be created without panicking
        assert_eq!(manager.sessions.blocking_read().len(), 0);
    }

    #[test]
    fn test_pty_manager_default() {
        let manager = PtyManager::default();
        // Should be created without panicking
        assert_eq!(manager.sessions.blocking_read().len(), 0);
    }

    // ============================================================================
    // PtyOutputEvent Tests
    // ============================================================================

    #[test]
    fn test_pty_output_event_creation() {
        let event = PtyOutputEvent {
            session_id: "test-session-123".to_string(),
            data: "aGVsbG8gd29ybGQ=".to_string(), // base64 encoded "hello world"
        };

        assert_eq!(event.session_id, "test-session-123");
        assert_eq!(event.data, "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn test_pty_output_event_serialization() {
        let event = PtyOutputEvent {
            session_id: "session-456".to_string(),
            data: "dGVzdCBkYXRh".to_string(), // "test data"
        };

        let json = serde_json::to_string(&event).expect("Should serialize");
        assert!(json.contains("session-456"));
        assert!(json.contains("dGVzdCBkYXRh"));

        let parsed: PtyOutputEvent = serde_json::from_str(&json).expect("Should deserialize");
        assert_eq!(parsed.session_id, "session-456");
        assert_eq!(parsed.data, "dGVzdCBkYXRh");
    }

    #[test]
    fn test_pty_output_event_with_empty_data() {
        let event = PtyOutputEvent {
            session_id: "empty-session".to_string(),
            data: String::new(),
        };

        assert_eq!(event.session_id, "empty-session");
        assert_eq!(event.data, "");
    }

    #[test]
    fn test_pty_output_event_with_large_base64_data() {
        // Large base64 string (512 bytes)
        let large_data = "a".repeat(512);
        let event = PtyOutputEvent {
            session_id: "large-session".to_string(),
            data: large_data.clone(),
        };

        assert_eq!(event.data.len(), 512);
        assert_eq!(event.data, large_data);
    }

    // ============================================================================
    // PtyExitEvent Tests
    // ============================================================================

    #[test]
    fn test_pty_exit_event_success() {
        let event = PtyExitEvent {
            session_id: "success-session".to_string(),
            exit_code: Some(0),
            error: None,
        };

        assert_eq!(event.session_id, "success-session");
        assert_eq!(event.exit_code, Some(0));
        assert_eq!(event.error, None);
    }

    #[test]
    fn test_pty_exit_event_failure() {
        let event = PtyExitEvent {
            session_id: "failed-session".to_string(),
            exit_code: Some(1),
            error: Some("Process crashed".to_string()),
        };

        assert_eq!(event.session_id, "failed-session");
        assert_eq!(event.exit_code, Some(1));
        assert_eq!(event.error, Some("Process crashed".to_string()));
    }

    #[test]
    fn test_pty_exit_event_no_exit_code() {
        let event = PtyExitEvent {
            session_id: "no-code-session".to_string(),
            exit_code: None,
            error: Some("Unknown error".to_string()),
        };

        assert_eq!(event.session_id, "no-code-session");
        assert_eq!(event.exit_code, None);
        assert_eq!(event.error, Some("Unknown error".to_string()));
    }

    #[test]
    fn test_pty_exit_event_serialization() {
        let event = PtyExitEvent {
            session_id: "test-serialize".to_string(),
            exit_code: Some(42),
            error: Some("Test error".to_string()),
        };

        let json = serde_json::to_string(&event).expect("Should serialize");
        assert!(json.contains("test-serialize"));
        assert!(json.contains("42"));
        assert!(json.contains("Test error"));

        let parsed: PtyExitEvent = serde_json::from_str(&json).expect("Should deserialize");
        assert_eq!(parsed.session_id, "test-serialize");
        assert_eq!(parsed.exit_code, Some(42));
        assert_eq!(parsed.error, Some("Test error".to_string()));
    }

    // ============================================================================
    // PtyError Tests
    // ============================================================================

    #[test]
    fn test_pty_error_spawn_failed() {
        let error = PtyError::SpawnFailed("PTY creation failed".to_string());
        let message = error.to_string();
        assert_eq!(message, "Failed to spawn PTY: PTY creation failed");
    }

    #[test]
    fn test_pty_error_session_not_found() {
        let error = PtyError::SessionNotFound("session-xyz".to_string());
        let message = error.to_string();
        assert_eq!(message, "Session not found: session-xyz");
    }

    #[test]
    fn test_pty_error_write_failed() {
        let error = PtyError::WriteFailed("I/O error".to_string());
        let message = error.to_string();
        assert_eq!(message, "Failed to write to PTY: I/O error");
    }

    #[test]
    fn test_pty_error_resize_failed() {
        let error = PtyError::ResizeFailed("Resize not supported".to_string());
        let message = error.to_string();
        assert_eq!(message, "Failed to resize PTY: Resize not supported");
    }

    #[test]
    fn test_pty_error_serialization() {
        let error = PtyError::SessionNotFound("missing-session".to_string());
        let json = serde_json::to_string(&error).expect("Should serialize");
        assert!(json.contains("missing-session"));

        let parsed: PtyError = serde_json::from_str(&json).expect("Should deserialize");
        match parsed {
            PtyError::SessionNotFound(id) => assert_eq!(id, "missing-session"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    // ============================================================================
    // Session Tracking Tests (async)
    // ============================================================================

    #[tokio::test]
    async fn test_has_session_empty() {
        let manager = PtyManager::new();
        assert!(!manager.has_session("non-existent").await);
    }

    #[tokio::test]
    async fn test_has_session_not_found() {
        let manager = PtyManager::new();
        assert!(!manager.has_session("fake-session-id").await);
    }

    #[tokio::test]
    async fn test_write_to_pty_session_not_found() {
        let manager = PtyManager::new();
        let result = manager.write_to_pty("non-existent", b"test").await;

        assert!(result.is_err());
        match result {
            Err(PtyError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    #[tokio::test]
    async fn test_resize_pty_session_not_found() {
        let manager = PtyManager::new();
        let result = manager.resize_pty("non-existent", 80, 24).await;

        assert!(result.is_err());
        match result {
            Err(PtyError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    #[tokio::test]
    async fn test_close_session_not_found() {
        let manager = PtyManager::new();
        let result = manager.close_session("non-existent").await;

        assert!(result.is_err());
        match result {
            Err(PtyError::SessionNotFound(id)) => assert_eq!(id, "non-existent"),
            _ => panic!("Expected SessionNotFound error"),
        }
    }

    // ============================================================================
    // Data Validation Tests
    // ============================================================================

    #[test]
    fn test_pty_output_event_unicode_session_id() {
        let event = PtyOutputEvent {
            session_id: "session-🚀-emoji".to_string(),
            data: "dGVzdA==".to_string(),
        };

        assert_eq!(event.session_id, "session-🚀-emoji");
        let json = serde_json::to_string(&event).expect("Should serialize unicode");
        let parsed: PtyOutputEvent =
            serde_json::from_str(&json).expect("Should deserialize unicode");
        assert_eq!(parsed.session_id, "session-🚀-emoji");
    }

    #[test]
    fn test_pty_exit_event_unicode_error_message() {
        let event = PtyExitEvent {
            session_id: "test".to_string(),
            exit_code: Some(1),
            error: Some("Error: 文字列 テスト".to_string()),
        };

        let json = serde_json::to_string(&event).expect("Should serialize unicode error");
        let parsed: PtyExitEvent =
            serde_json::from_str(&json).expect("Should deserialize unicode error");
        assert_eq!(parsed.error, Some("Error: 文字列 テスト".to_string()));
    }

    #[test]
    fn test_pty_output_event_special_characters_in_session_id() {
        let special_id = "session-!@#$%^&*()_+-=[]{}|:;<>?,./".to_string();
        let event = PtyOutputEvent {
            session_id: special_id.clone(),
            data: "dGVzdA==".to_string(),
        };

        assert_eq!(event.session_id, special_id);
    }

    #[test]
    fn test_pty_error_with_very_long_message() {
        let long_message = "x".repeat(1024);
        let error = PtyError::WriteFailed(long_message.clone());
        let message = error.to_string();
        assert!(message.contains(&long_message));
        assert_eq!(message.len(), 1024 + "Failed to write to PTY: ".len());
    }

    // ============================================================================
    // Edge Cases
    // ============================================================================

    #[test]
    fn test_pty_exit_event_zero_exit_code() {
        // Zero exit code typically means success
        let event = PtyExitEvent {
            session_id: "success".to_string(),
            exit_code: Some(0),
            error: None,
        };

        assert_eq!(event.exit_code, Some(0));
        assert_eq!(event.error, None);
    }

    #[test]
    fn test_pty_exit_event_negative_exit_code() {
        // Negative exit codes can result from signal termination
        let event = PtyExitEvent {
            session_id: "killed".to_string(),
            exit_code: Some(-15),
            error: None,
        };

        assert_eq!(event.exit_code, Some(-15));
    }

    #[test]
    fn test_pty_exit_event_high_exit_code() {
        // Some processes use high exit codes
        let event = PtyExitEvent {
            session_id: "high-exit".to_string(),
            exit_code: Some(255),
            error: None,
        };

        assert_eq!(event.exit_code, Some(255));
    }

    #[tokio::test]
    async fn test_multiple_sessions_do_not_interfere() {
        let manager = PtyManager::new();

        // Check that operations on one session don't affect another
        assert!(!manager.has_session("session-1").await);
        assert!(!manager.has_session("session-2").await);

        // Attempting to operate on session-1 should fail
        let result = manager.write_to_pty("session-1", b"test").await;
        assert!(result.is_err());

        // session-2 should still not exist
        assert!(!manager.has_session("session-2").await);
    }

    #[test]
    fn test_pty_output_event_with_multiline_base64() {
        let multiline_data = "SGVsbG8gV29ybGQhCkFsdG8gTXVuZG8h".to_string();
        let event = PtyOutputEvent {
            session_id: "multiline".to_string(),
            data: multiline_data.clone(),
        };

        assert_eq!(event.data, multiline_data);
    }

    #[test]
    fn test_pty_exit_event_both_code_and_error() {
        // Event can have both an exit code and an error message
        let event = PtyExitEvent {
            session_id: "both".to_string(),
            exit_code: Some(127),
            error: Some("Command not found".to_string()),
        };

        assert_eq!(event.exit_code, Some(127));
        assert_eq!(event.error, Some("Command not found".to_string()));
    }

    #[test]
    fn test_pty_error_debug_format() {
        let error = PtyError::SessionNotFound("debug-test".to_string());
        let debug = format!("{:?}", error);
        assert!(debug.contains("SessionNotFound"));
        assert!(debug.contains("debug-test"));
    }

    #[test]
    fn test_pty_error_clone() {
        let error1 = PtyError::WriteFailed("original".to_string());
        let error2 = error1.clone();

        match (error1, error2) {
            (PtyError::WriteFailed(msg1), PtyError::WriteFailed(msg2)) => {
                assert_eq!(msg1, "original");
                assert_eq!(msg2, "original");
            }
            _ => panic!("Expected WriteFailed variants"),
        }
    }

    #[test]
    fn test_session_id_uniqueness_check() {
        // Session IDs should be treated as distinct strings
        let session_a = "session-a".to_string();
        let session_b = "session-b".to_string();

        let event_a = PtyOutputEvent {
            session_id: session_a.clone(),
            data: "data-a".to_string(),
        };

        let event_b = PtyOutputEvent {
            session_id: session_b.clone(),
            data: "data-b".to_string(),
        };

        assert_ne!(event_a.session_id, event_b.session_id);
        assert_ne!(event_a.data, event_b.data);
    }
}
