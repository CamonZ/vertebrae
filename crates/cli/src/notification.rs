//! Notification client for notifying Tauri of CLI mutations
//!
//! After CLI commands mutate data, they can call functions in this module to notify
//! the Tauri backend of changes. The Tauri backend listens on an HTTP server and
//! converts these notifications to events that trigger frontend cache invalidation.

use serde::Serialize;

/// Default port that the Tauri notification server listens on
pub const NOTIFICATION_PORT: u16 = 17273;

/// Notification payload sent to Tauri
#[derive(Debug, Serialize, Clone)]
pub struct NotificationPayload {
    /// ID of the task that changed (optional - one of task_id or workflow_id required)
    pub task_id: Option<String>,
    /// ID of the workflow that changed (optional - one of task_id or workflow_id required)
    pub workflow_id: Option<String>,
    /// Type of change: Created, Updated, Deleted, StatusChanged
    pub change_type: String,
}

/// Notify Tauri of a task change
///
/// Posts to the notification server if Tauri is running. Fails gracefully if
/// the server is not available (doesn't fail the CLI operation).
///
/// # Arguments
/// * `task_id` - The ID of the task that changed (e.g., "task:123")
/// * `change_type` - Type of change: "Created", "Updated", "Deleted", or "StatusChanged"
///
/// # Returns
/// Ok(()) if notification sent successfully or Tauri not running
/// Err only if the request itself failed (not if Tauri isn't running)
pub async fn notify_task_changed(task_id: String, change_type: &str) {
    let payload = NotificationPayload {
        task_id: Some(task_id.clone()),
        workflow_id: None,
        change_type: change_type.to_string(),
    };

    if let Err(e) = send_notification(&payload).await {
        // Log but don't fail - Tauri might not be running
        log::debug!(
            "[Notification] Failed to notify task change for {}: {}",
            task_id,
            e
        );
    }
}

/// Notify Tauri of a workflow change
///
/// Posts to the notification server if Tauri is running. Fails gracefully if
/// the server is not available (doesn't fail the CLI operation).
///
/// # Arguments
/// * `workflow_id` - The ID of the workflow that changed (e.g., "workflow:default")
/// * `change_type` - Type of change: "Created", "Updated", or "Deleted"
///
/// # Returns
/// Ok(()) if notification sent successfully or Tauri not running
pub async fn notify_workflow_changed(workflow_id: String, change_type: &str) {
    let payload = NotificationPayload {
        task_id: None,
        workflow_id: Some(workflow_id.clone()),
        change_type: change_type.to_string(),
    };

    if let Err(e) = send_notification(&payload).await {
        // Log but don't fail - Tauri might not be running
        log::debug!(
            "[Notification] Failed to notify workflow change for {}: {}",
            workflow_id,
            e
        );
    }
}

/// Send a notification payload to the Tauri notification server
///
/// This is the low-level function that handles the actual HTTP POST.
/// Higher-level functions (notify_task_changed, notify_workflow_changed) should
/// be used instead for type safety and convenience.
async fn send_notification(payload: &NotificationPayload) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/notify-change", NOTIFICATION_PORT);

    // Create a simple HTTP client request
    // Using reqwest would add a dependency, so we'll use the built-in http capabilities
    // via a minimal implementation
    match make_http_request(&url, payload).await {
        Ok(_) => {
            log::debug!("[Notification] Sent notification: {:?}", payload);
            Ok(())
        }
        Err(e) => Err(format!("HTTP request failed: {}", e)),
    }
}

/// Make an HTTP POST request to the notification server
///
/// This uses tokio's built-in networking to avoid adding heavy dependencies.
async fn make_http_request(url: &str, payload: &NotificationPayload) -> Result<(), String> {
    // Parse URL to extract host and path
    let url = url
        .parse::<http::Uri>()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let host = url.host().ok_or("No host in URL")?;
    let port = url.port_u16().unwrap_or(17273);
    let path = url.path();

    // Serialize payload to JSON
    let body =
        serde_json::to_string(payload).map_err(|e| format!("JSON serialization failed: {}", e))?;

    // Build HTTP request
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path,
        host,
        body.len(),
        body
    );

    // Connect and send
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let connect_timeout = Duration::from_secs(1);
    let stream = tokio::time::timeout(connect_timeout, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "Connection timeout".to_string())?
        .map_err(|e| format!("Connection failed: {}", e))?;

    let mut stream = stream;
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    // Read response (we only care that it succeeds, not the actual body)
    let mut buffer = [0; 512];
    let _n = stream
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notification_payload_task() {
        let payload = NotificationPayload {
            task_id: Some("task:123".to_string()),
            workflow_id: None,
            change_type: "Created".to_string(),
        };

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("task:123"));
        assert!(json.contains("Created"));
    }

    #[test]
    fn test_notification_payload_workflow() {
        let payload = NotificationPayload {
            task_id: None,
            workflow_id: Some("workflow:default".to_string()),
            change_type: "Updated".to_string(),
        };

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("workflow:default"));
        assert!(json.contains("Updated"));
    }
}
