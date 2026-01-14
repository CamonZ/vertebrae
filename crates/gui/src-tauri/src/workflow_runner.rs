//! Workflow execution engine stub
//!
//! This module will contain the workflow execution implementation.
//! Work in progress - structure being defined.

use std::path::PathBuf;

/// Public message type for workflow supervisor
#[derive(Debug, Clone)]
pub enum WorkflowSupervisorMessage {
    StartWorkflow { task_id: String },
}

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
