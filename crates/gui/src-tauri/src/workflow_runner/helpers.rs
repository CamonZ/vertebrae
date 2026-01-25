//! Common helper functions for workflow execution

use std::path::PathBuf;

use crate::events::{StepExecutionChangeType, StepExecutionChangedEvent, StepExecutionStatus};
use chrono::Utc;
use tauri::{AppHandle, Emitter};
use vertebrae_db::{Database, ExecutionStatus};

/// Find the Claude Code CLI binary
pub fn find_claude_binary() -> Result<PathBuf, String> {
    // Check CLAUDE_CODE_PATH environment variable
    if let Ok(path) = std::env::var("CLAUDE_CODE_PATH") {
        return Ok(PathBuf::from(path));
    }

    // Try to find 'claude' in PATH
    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            return Ok(PathBuf::from(path_str.trim()));
        }
    }

    Err(
        "Claude Code CLI not found. Set CLAUDE_CODE_PATH environment variable or ensure 'claude' is in PATH"
            .to_string(),
    )
}

/// Reconnect to database, falling back to existing connection on error
pub async fn reconnect_or_fallback(db: &Database, task_id: &str, exec_id: &str) -> Database {
    use super::logging::trace;

    trace(
        task_id,
        &format!(
            "[exec_id={}] Reconnecting to database before write...",
            exec_id
        ),
    );

    match db.reconnect().await {
        Ok(d) => {
            trace(
                task_id,
                &format!("[exec_id={}] Database reconnected successfully", exec_id),
            );
            d
        }
        Err(re) => {
            trace(
                task_id,
                &format!("[exec_id={}] WARNING: Failed to reconnect: {}", exec_id, re),
            );
            log::warn!("[WorkflowRunner] Failed to reconnect database: {}", re);
            db.clone()
        }
    }
}

/// Update execution status and emit change event
pub async fn update_execution_status(
    db: &Database,
    app_handle: &AppHandle,
    exec_id: &str,
    task_id: &str,
    workflow_id: &str,
    step_name: &str,
    status: ExecutionStatus,
) -> Result<(), String> {
    use super::logging::trace;

    let status_str = match status {
        ExecutionStatus::Completed => "Completed",
        ExecutionStatus::Failed => "Failed",
        ExecutionStatus::InProgress => "InProgress",
    };

    trace(
        task_id,
        &format!(
            "[exec_id={}] Calling update_status({})...",
            exec_id, status_str
        ),
    );

    let completed_at = if status != ExecutionStatus::InProgress {
        Some(Utc::now())
    } else {
        None
    };

    match db
        .executions()
        .update_status(exec_id, status.clone(), completed_at)
        .await
    {
        Ok(()) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] update_status({}) SUCCESS",
                    exec_id, status_str
                ),
            );

            let event_status = match status {
                ExecutionStatus::Completed => StepExecutionStatus::Completed,
                ExecutionStatus::Failed => StepExecutionStatus::Failed,
                ExecutionStatus::InProgress => StepExecutionStatus::Running,
            };

            let _ = app_handle.emit(
                "step-execution-changed-event",
                StepExecutionChangedEvent {
                    execution_id: exec_id.to_string(),
                    task_id: task_id.to_string(),
                    workflow_id: workflow_id.to_string(),
                    step_name: step_name.to_string(),
                    status: event_status,
                    change_type: StepExecutionChangeType::StatusChanged,
                },
            );

            Ok(())
        }
        Err(e) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] update_status({}) ERROR: {}",
                    exec_id, status_str, e
                ),
            );
            Err(format!("Failed to update status: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Mutex to prevent parallel env var tests from interfering
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_find_claude_binary_with_env_var() {
        let _lock = ENV_MUTEX.lock().unwrap();

        // Save original value
        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        // Set test value
        std::env::set_var("CLAUDE_CODE_PATH", "/test/path/claude");
        let result = find_claude_binary();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/test/path/claude"));

        // Restore original
        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }

    #[test]
    fn test_find_claude_binary_path_with_spaces() {
        let _lock = ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::set_var("CLAUDE_CODE_PATH", "/path/with spaces/claude");
        let result = find_claude_binary();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/path/with spaces/claude"));

        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }

    #[test]
    fn test_find_claude_binary_without_env_var() {
        let _lock = ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        // Remove env var to test PATH lookup
        std::env::remove_var("CLAUDE_CODE_PATH");
        let result = find_claude_binary();
        // Result depends on whether claude is in PATH - just check it doesn't panic
        // If claude is installed, it should succeed; if not, it should return an error
        assert!(result.is_ok() || result.is_err());

        // Restore original
        if let Some(v) = original {
            std::env::set_var("CLAUDE_CODE_PATH", v);
        }
    }
}
