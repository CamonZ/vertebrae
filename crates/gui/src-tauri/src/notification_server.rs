//! HTTP server for receiving mutation notifications from CLI
//!
//! The CLI makes POST requests to /api/notify-change after mutations,
//! which are converted to TaskChangedEvent or WorkflowChangedEvent and emitted to the frontend.

use axum::{
    extract::Json,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;

use crate::events::{TaskChangeType, TaskChangedEvent, WorkflowChangeType, WorkflowChangedEvent};

/// Default port for the notification server
pub const DEFAULT_NOTIFICATION_PORT: u16 = 17273;

/// Payload received from CLI for cache invalidation
#[derive(Debug, Deserialize)]
pub struct NotificationPayload {
    /// ID of the task that changed (optional - one of task_id or workflow_id required)
    pub task_id: Option<String>,
    /// ID of the workflow that changed (optional - one of task_id or workflow_id required)
    pub workflow_id: Option<String>,
    /// Type of change that occurred
    pub change_type: String,
}

/// Error response for invalid payloads
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

impl IntoResponse for ErrorResponse {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
}

/// Success response for valid notifications
#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    pub status: String,
}

impl IntoResponse for SuccessResponse {
    fn into_response(self) -> Response {
        (StatusCode::OK, Json(self)).into_response()
    }
}

/// Handle POST /api/notify-change request
async fn handle_notify_change(
    app_handle: axum::extract::State<Arc<AppHandle>>,
    Json(payload): Json<NotificationPayload>,
) -> Result<SuccessResponse, ErrorResponse> {
    log::debug!(
        "[NotificationServer] Received notification: task_id={:?}, workflow_id={:?}, change_type={}",
        payload.task_id,
        payload.workflow_id,
        payload.change_type
    );

    // Must have at least one ID
    if payload.task_id.is_none() && payload.workflow_id.is_none() {
        return Err(ErrorResponse {
            error: "Must provide either task_id or workflow_id".to_string(),
        });
    }

    // Handle task changes
    if let Some(task_id) = payload.task_id {
        let change_type = match payload.change_type.as_str() {
            "Created" => TaskChangeType::Created,
            "Updated" => TaskChangeType::Updated,
            "Deleted" => TaskChangeType::Deleted,
            "StatusChanged" => TaskChangeType::StatusChanged,
            other => {
                return Err(ErrorResponse {
                    error: format!("Unknown task change type: {}", other),
                });
            }
        };

        let event = TaskChangedEvent {
            task_id,
            change_type,
        };
        log::info!(
            "[NotificationServer] Emitting TaskChangedEvent: {:?}",
            event
        );

        if let Err(e) = app_handle.emit("task-changed-event", &event) {
            log::error!(
                "[NotificationServer] Failed to emit TaskChangedEvent: {}",
                e
            );
            return Err(ErrorResponse {
                error: format!("Failed to emit event: {}", e),
            });
        }
    }

    // Handle workflow changes
    if let Some(workflow_id) = payload.workflow_id {
        let change_type = match payload.change_type.as_str() {
            "Created" => WorkflowChangeType::Created,
            "Updated" => WorkflowChangeType::Updated,
            "Deleted" => WorkflowChangeType::Deleted,
            other => {
                return Err(ErrorResponse {
                    error: format!("Unknown workflow change type: {}", other),
                });
            }
        };

        let event = WorkflowChangedEvent {
            workflow_id,
            change_type,
        };
        log::info!(
            "[NotificationServer] Emitting WorkflowChangedEvent: {:?}",
            event
        );

        if let Err(e) = app_handle.emit("workflow-changed-event", &event) {
            log::error!(
                "[NotificationServer] Failed to emit WorkflowChangedEvent: {}",
                e
            );
            return Err(ErrorResponse {
                error: format!("Failed to emit event: {}", e),
            });
        }
    }

    Ok(SuccessResponse {
        status: "ok".to_string(),
    })
}

/// Start the HTTP server for mutation notifications
///
/// Spawns an async task that listens on localhost:port for POST /api/notify-change requests.
/// Runs on a separate tokio task to avoid blocking Tauri setup.
///
/// # Arguments
/// * `app_handle` - Tauri app handle for emitting events
/// * `port` - Port to listen on
///
/// # Returns
/// Tokio task handle that will run for the lifetime of the app
pub fn start_notification_server(app_handle: AppHandle, port: u16) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let app_handle = Arc::new(app_handle);

        let app = Router::new()
            .route("/api/notify-change", post(handle_notify_change))
            .with_state(app_handle.clone());

        let listener = match TcpListener::bind(format!("127.0.0.1:{}", port)).await {
            Ok(l) => {
                log::info!(
                    "[NotificationServer] HTTP server listening on 127.0.0.1:{}",
                    port
                );
                l
            }
            Err(e) => {
                log::error!(
                    "[NotificationServer] Failed to bind to 127.0.0.1:{}: {}",
                    port,
                    e
                );
                return;
            }
        };

        let axum_listener = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        );

        if let Err(e) = axum_listener.await {
            log::error!("[NotificationServer] Server error: {}", e);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notification_payload_deserialization() {
        let json = r#"{"task_id": "task:123", "change_type": "Created"}"#;
        let payload: NotificationPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.task_id, Some("task:123".to_string()));
        assert_eq!(payload.workflow_id, None);
        assert_eq!(payload.change_type, "Created");
    }

    #[test]
    fn test_workflow_notification_payload() {
        let json = r#"{"workflow_id": "workflow:456", "change_type": "Updated"}"#;
        let payload: NotificationPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.task_id, None);
        assert_eq!(payload.workflow_id, Some("workflow:456".to_string()));
        assert_eq!(payload.change_type, "Updated");
    }
}
