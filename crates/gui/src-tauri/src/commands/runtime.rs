use super::*;

// ============================================================================
// Runtime Status and Lifecycle Commands
// ============================================================================

// ============================================================================
// WebSocket Status Command
// ============================================================================

/// Get the current WebSocket connection status
#[tauri::command]
#[specta::specta]
pub async fn get_websocket_status(
    socket: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
) -> Result<String, CommandError> {
    let guard = socket.lock().await;
    let status = guard.get_state().await;
    let status_str = match status {
        crate::websocket_client::ConnectionState::Disconnected => "disconnected",
        crate::websocket_client::ConnectionState::Connecting => "connecting",
        crate::websocket_client::ConnectionState::Connected => "connected",
        crate::websocket_client::ConnectionState::Reconnecting => "reconnecting",
    };
    Ok(status_str.to_string())
}

/// Quit the application.
///
/// Used by the first-run install screen's Cancel button so a user who does not
/// want to install the bundled tools can exit cleanly rather than being routed
/// into an app that can't function without them.
#[tauri::command]
#[specta::specta]
pub async fn quit_application(app_handle: tauri::AppHandle) -> Result<(), CommandError> {
    app_handle.exit(0);
    Ok(())
}
