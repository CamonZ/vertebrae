//! Local chat permission bridge for agent approval prompts.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(unix)]
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use tauri::Emitter;

#[cfg(unix)]
use crate::events::PermissionRequestEvent;

#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;
#[cfg(unix)]
const PERMISSION_SOCKET_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPermissionDecision {
    pub behavior: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<serde_json::Value>,
}

#[cfg(unix)]
#[derive(Debug, Deserialize)]
struct PermissionSocketRequest {
    request_id: String,
    tool_name: String,
    tool_use_id: String,
    #[serde(default)]
    input: serde_json::Value,
}

struct PendingPermission {
    session_id: String,
    response_tx: std::sync::mpsc::Sender<LocalPermissionDecision>,
}

#[derive(Clone)]
pub(crate) struct PermissionBridge {
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

#[cfg(unix)]
pub(crate) struct PermissionSocketGuard {
    path: std::path::PathBuf,
    directory: std::path::PathBuf,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(unix)]
impl PermissionSocketGuard {
    pub(crate) fn path(&self) -> &std::path::Path {
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

impl PermissionBridge {
    pub(crate) fn new() -> Self {
        Self {
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(unix)]
    pub(crate) fn start_socket(
        &self,
        session_id: &str,
        app_handle: tauri::AppHandle,
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
        let bridge = self.clone();
        std::thread::spawn(move || {
            while !stop_for_thread.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _addr)) => {
                        let app_handle = app_handle.clone();
                        let session_id = session_id_for_listener.clone();
                        let bridge = bridge.clone();
                        std::thread::spawn(move || {
                            bridge.handle_permission_socket_connection(
                                stream, session_id, app_handle,
                            );
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(25));
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
        &self,
        mut stream: std::os::unix::net::UnixStream,
        session_id: String,
        app_handle: tauri::AppHandle,
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
        if let Err(message) =
            self.register_pending_request(&request.request_id, &session_id, response_tx)
        {
            let _ = Self::write_permission_socket_error(&mut stream, message);
            return;
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
            self.remove_pending_request(&request.request_id);
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
    fn register_pending_request(
        &self,
        request_id: &str,
        session_id: &str,
        response_tx: std::sync::mpsc::Sender<LocalPermissionDecision>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_permissions
            .lock()
            .map_err(|_| "permission responder lock is poisoned".to_string())?;
        if pending.contains_key(request_id) {
            return Err(format!("duplicate permission request id: {request_id}"));
        }
        pending.insert(
            request_id.to_string(),
            PendingPermission {
                session_id: session_id.to_string(),
                response_tx,
            },
        );
        Ok(())
    }

    #[cfg(unix)]
    fn remove_pending_request(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending_permissions.lock() {
            pending.remove(request_id);
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

    pub(crate) fn resolve_permission_request(
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

    pub(crate) fn fail_pending_permissions_for_session(
        &self,
        session_id: &str,
        cancellation_message: impl Into<String>,
    ) {
        let cancellation_message = cancellation_message.into();
        let pending_for_session = {
            let mut pending = match self.pending_permissions.lock() {
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
                message: Some(cancellation_message.clone()),
                updated_input: None,
            });
        }
    }
}

#[cfg(test)]
mod tests;
