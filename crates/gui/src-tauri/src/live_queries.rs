//! SurrealDB LIVE query management for real-time data synchronization
//!
//! This module provides infrastructure for setting up and managing LIVE SELECT
//! queries on the task and workflow tables to detect create/update/delete operations in real-time.
//!
//! # Architecture
//!
//! - LIVE queries are started after database initialization
//! - Stream handles are stored in a registry to keep them alive for the app lifetime
//! - Notifications are converted to Tauri events and emitted to the frontend
//!
//! # Constraints
//!
//! - LIVE queries only supported in single-node SurrealDB (verified for SurrealKv backend)
//! - Streams auto-close when dropped; handles must be kept alive
//! - Don't use KILL statement for termination (known SDK issue - may hang client stream)

use futures::StreamExt;
use serde::Deserialize;
use surrealdb::engine::local::Db;
use surrealdb::{Notification, Surreal};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::events::{TaskChangeType, TaskChangedEvent, WorkflowChangeType, WorkflowChangedEvent};

/// Table name for tasks in SurrealDB
const TASK_TABLE: &str = "task";

/// Table name for workflows in SurrealDB
const WORKFLOW_TABLE: &str = "workflow";

/// Row type for deserializing task notifications from LIVE SELECT
///
/// Only includes the id field since we just need to know which task changed.
/// The frontend will fetch the full task data when it receives the event.
#[derive(Debug, Deserialize)]
struct TaskNotificationRow {
    /// The task's record ID (SurrealDB Thing type)
    id: surrealdb::sql::Thing,
}

/// Row type for deserializing workflow notifications from LIVE SELECT
///
/// Only includes the id field since we just need to know which workflow changed.
/// The frontend will fetch the full workflow data when it receives the event.
/// Note: Step changes are detected as workflow updates since steps are stored
/// as an array within the workflow record.
#[derive(Debug, Deserialize)]
struct WorkflowNotificationRow {
    /// The workflow's record ID (SurrealDB Thing type)
    id: surrealdb::sql::Thing,
}

/// Registry for holding LIVE query stream handles
///
/// This struct keeps the spawned task handles alive for the duration of the app.
/// When dropped, the streams will be automatically closed.
pub struct LiveQueryRegistry {
    /// Handle to the task table LIVE query processing task
    task_stream_handle: Option<JoinHandle<()>>,
    /// Handle to the workflow table LIVE query processing task
    workflow_stream_handle: Option<JoinHandle<()>>,
}

impl LiveQueryRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            task_stream_handle: None,
            workflow_stream_handle: None,
        }
    }

    /// Start LIVE SELECT on the task table and begin processing notifications
    ///
    /// This method spawns an async task that:
    /// 1. Opens a LIVE SELECT stream on the task table
    /// 2. Processes each notification (Create/Update/Delete)
    /// 3. Emits corresponding Tauri events to the frontend
    ///
    /// # Arguments
    ///
    /// * `client` - The SurrealDB client to use for the LIVE query
    /// * `app_handle` - The Tauri app handle for emitting events
    ///
    /// # Errors
    ///
    /// If the LIVE query fails to start, an error is logged but the app continues
    /// running (graceful degradation to polling fallback).
    pub async fn start_task_live_query(
        &mut self,
        client: Surreal<Db>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Set the namespace and database context for this client
        client
            .use_ns("vertebrae")
            .use_db("main")
            .await
            .map_err(|e| format!("Failed to set namespace/database context: {}", e))?;

        // Start LIVE SELECT on task table
        let stream_result = client.select(TASK_TABLE).live().await;

        let mut stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to start LIVE query on task table: {}", e);
                return Err(format!("Failed to start LIVE query: {}", e));
            }
        };

        log::info!("LIVE query started on task table - now listening for changes...");

        // Spawn a task to process the notification stream
        let handle = tokio::spawn(async move {
            log::info!(
                "[LiveQuery] Task stream listening loop started, waiting for notifications..."
            );
            while let Some(result) = stream.next().await {
                match result {
                    Ok(notification) => {
                        handle_task_notification(notification, &app_handle);
                    }
                    Err(e) => {
                        // Log error but continue processing - don't panic on individual errors
                        log::error!("Error in task LIVE query stream: {}", e);
                    }
                }
            }

            // Stream ended (either naturally or due to disconnect)
            log::warn!("Task LIVE query stream ended");
        });

        self.task_stream_handle = Some(handle);
        Ok(())
    }

    /// Check if the task LIVE query is currently running
    pub fn is_task_stream_active(&self) -> bool {
        self.task_stream_handle
            .as_ref()
            .map(|h| !h.is_finished())
            .unwrap_or(false)
    }

    /// Start LIVE SELECT on the workflow table and begin processing notifications
    ///
    /// This method spawns an async task that:
    /// 1. Opens a LIVE SELECT stream on the workflow table
    /// 2. Processes each notification (Create/Update/Delete)
    /// 3. Emits corresponding Tauri events to the frontend
    ///
    /// Note: Step changes within a workflow are detected as workflow Update notifications
    /// since steps are stored as an array within the workflow record.
    ///
    /// # Arguments
    ///
    /// * `client` - The SurrealDB client to use for the LIVE query
    /// * `app_handle` - The Tauri app handle for emitting events
    ///
    /// # Errors
    ///
    /// If the LIVE query fails to start, an error is logged but the app continues
    /// running (graceful degradation to polling fallback).
    pub async fn start_workflow_live_query(
        &mut self,
        client: Surreal<Db>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Set the namespace and database context for this client
        client
            .use_ns("vertebrae")
            .use_db("main")
            .await
            .map_err(|e| format!("Failed to set namespace/database context: {}", e))?;

        // Start LIVE SELECT on workflow table
        let stream_result = client.select(WORKFLOW_TABLE).live().await;

        let mut stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to start LIVE query on workflow table: {}", e);
                return Err(format!("Failed to start LIVE query: {}", e));
            }
        };

        log::info!("LIVE query started on workflow table - now listening for changes...");

        // Spawn a task to process the notification stream
        let handle = tokio::spawn(async move {
            log::info!(
                "[LiveQuery] Workflow stream listening loop started, waiting for notifications..."
            );
            while let Some(result) = stream.next().await {
                match result {
                    Ok(notification) => {
                        handle_workflow_notification(notification, &app_handle);
                    }
                    Err(e) => {
                        // Log error but continue processing - don't panic on individual errors
                        log::error!("Error in workflow LIVE query stream: {}", e);
                    }
                }
            }

            // Stream ended (either naturally or due to disconnect)
            log::warn!("Workflow LIVE query stream ended");
        });

        self.workflow_stream_handle = Some(handle);
        Ok(())
    }

    /// Check if the workflow LIVE query is currently running
    pub fn is_workflow_stream_active(&self) -> bool {
        self.workflow_stream_handle
            .as_ref()
            .map(|h| !h.is_finished())
            .unwrap_or(false)
    }
}

impl Default for LiveQueryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LiveQueryRegistry {
    fn drop(&mut self) {
        // Abort any running stream tasks when the registry is dropped
        if let Some(handle) = self.task_stream_handle.take() {
            handle.abort();
            log::info!("Task LIVE query stream aborted on registry drop");
        }
        if let Some(handle) = self.workflow_stream_handle.take() {
            handle.abort();
            log::info!("Workflow LIVE query stream aborted on registry drop");
        }
    }
}

/// Handle a single task notification from the LIVE query stream
///
/// Converts the SurrealDB notification into a Tauri event and emits it to the frontend.
fn handle_task_notification(
    notification: Notification<TaskNotificationRow>,
    app_handle: &AppHandle,
) {
    // Extract task ID from the notification data
    let task_id = notification.data.id.id.to_raw();

    // Convert SurrealDB action to our TaskChangeType
    let change_type = match notification.action {
        surrealdb::Action::Create => TaskChangeType::Created,
        surrealdb::Action::Update => TaskChangeType::Updated,
        surrealdb::Action::Delete => TaskChangeType::Deleted,
        _ => {
            log::warn!("Unknown action type in task notification");
            return;
        }
    };

    log::info!(
        "[LiveQuery] Task change detected: {} - {:?}",
        task_id
            .rsplit_once(':')
            .map(|(_, id)| id)
            .unwrap_or(&task_id),
        change_type
    );

    // Emit Tauri event to frontend
    let event = TaskChangedEvent {
        task_id: task_id.clone(),
        change_type: change_type.clone(),
    };

    if let Err(e) = app_handle.emit("task-changed-event", &event) {
        log::error!(
            "[LiveQuery] Failed to emit TaskChangedEvent for {}: {}",
            task_id,
            e
        );
    } else {
        log::info!(
            "[LiveQuery] TaskChangedEvent emitted to frontend: {} - {:?}",
            task_id
                .rsplit_once(':')
                .map(|(_, id)| id)
                .unwrap_or(&task_id),
            change_type
        );
    }
}

/// Handle a single workflow notification from the LIVE query stream
///
/// Converts the SurrealDB notification into a Tauri event and emits it to the frontend.
/// Note: When workflow steps are modified, this results in a workflow Update notification
/// since steps are stored as an array within the workflow record.
fn handle_workflow_notification(
    notification: Notification<WorkflowNotificationRow>,
    app_handle: &AppHandle,
) {
    // Extract workflow ID from the notification data
    let workflow_id = notification.data.id.id.to_raw();

    // Convert SurrealDB action to our WorkflowChangeType
    let change_type = match notification.action {
        surrealdb::Action::Create => WorkflowChangeType::Created,
        surrealdb::Action::Update => WorkflowChangeType::Updated,
        surrealdb::Action::Delete => WorkflowChangeType::Deleted,
        _ => {
            log::warn!("Unknown action type in workflow notification");
            return;
        }
    };

    log::info!(
        "[LiveQuery] Workflow change detected: {} - {:?}",
        workflow_id
            .rsplit_once(':')
            .map(|(_, id)| id)
            .unwrap_or(&workflow_id),
        change_type
    );

    // Emit Tauri event to frontend
    let event = WorkflowChangedEvent {
        workflow_id: workflow_id.clone(),
        change_type: change_type.clone(),
    };

    if let Err(e) = app_handle.emit("workflow-changed-event", &event) {
        log::error!(
            "[LiveQuery] Failed to emit WorkflowChangedEvent for {}: {}",
            workflow_id,
            e
        );
    } else {
        log::info!(
            "[LiveQuery] WorkflowChangedEvent emitted to frontend: {} - {:?}",
            workflow_id
                .rsplit_once(':')
                .map(|(_, id)| id)
                .unwrap_or(&workflow_id),
            change_type
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_live_query_registry_new() {
        let registry = LiveQueryRegistry::new();
        assert!(!registry.is_task_stream_active());
        assert!(!registry.is_workflow_stream_active());
    }

    #[test]
    fn test_live_query_registry_default() {
        let registry = LiveQueryRegistry::default();
        assert!(!registry.is_task_stream_active());
        assert!(!registry.is_workflow_stream_active());
    }

    #[test]
    fn test_live_query_registry_workflow_stream_inactive_initially() {
        let registry = LiveQueryRegistry::new();
        // Workflow stream should be inactive when no query has been started
        assert!(!registry.is_workflow_stream_active());
    }

    // Integration tests for LIVE queries would require a running SurrealDB instance
    // and are better suited for integration test suites with proper setup/teardown
}
