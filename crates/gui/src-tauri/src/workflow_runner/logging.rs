//! Workflow execution logging utilities
//!
//! Logs are written to `~/.vertebrae/workflow-logs/{task_id}.log`

use std::path::PathBuf;

/// Get the workflow logs directory, creating it if needed
pub fn get_workflow_logs_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let logs_dir = PathBuf::from(home).join(".vertebrae").join("workflow-logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs dir: {}", e))?;
    Ok(logs_dir)
}

/// Get the log file path for a task
pub fn get_workflow_log_path(task_id: &str) -> Result<PathBuf, String> {
    let logs_dir = get_workflow_logs_dir()?;
    Ok(logs_dir.join(format!("{}.log", task_id)))
}

/// Append output to the workflow log file for a task
///
/// Each entry is a single line: [timestamp] [phase] content
pub fn append_to_workflow_log(
    task_id: &str,
    phase: &str,
    content: &str,
) -> Result<PathBuf, String> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let log_path = get_workflow_log_path(task_id)?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let log_line = format!("[{}] [{}] {}\n", timestamp, phase, content);

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    file.write_all(log_line.as_bytes())
        .map_err(|e| format!("Failed to write log line: {}", e))?;

    Ok(log_path)
}

/// Trace a message to the workflow log file
///
/// Used for exhaustive tracing of workflow execution flow.
pub fn trace(task_id: &str, message: &str) {
    let _ = append_to_workflow_log(task_id, "TRACE", message);
    log::debug!("[WorkflowRunner][TRACE] {}", message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_get_workflow_logs_dir() {
        let result = get_workflow_logs_dir();
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("workflow-logs"));
    }

    #[test]
    fn test_get_workflow_logs_dir_creates_directory() {
        let result = get_workflow_logs_dir();
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.exists(), "Directory should be created");
        assert!(path.is_dir(), "Path should be a directory");
    }

    #[test]
    fn test_get_workflow_log_path() {
        let result = get_workflow_log_path("test-task-123");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("test-task-123.log"));
    }

    #[test]
    fn test_get_workflow_log_path_with_special_chars() {
        let result = get_workflow_log_path("task_with-dashes_and_underscores");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("task_with-dashes_and_underscores.log"));
    }

    #[test]
    fn test_append_to_workflow_log() {
        let task_id = "test-append-log";
        let result = append_to_workflow_log(task_id, "TEST", "Hello, world!");
        assert!(result.is_ok());

        // Verify content was written
        let log_path = result.unwrap();
        let content = fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("[TEST]"));
        assert!(content.contains("Hello, world!"));

        // Cleanup
        let _ = fs::remove_file(log_path);
    }

    #[test]
    fn test_append_to_workflow_log_multiple_entries() {
        let task_id = "test-multiple-entries";

        // Write multiple entries
        let _ = append_to_workflow_log(task_id, "PHASE1", "First entry");
        let _ = append_to_workflow_log(task_id, "PHASE2", "Second entry");
        let result = append_to_workflow_log(task_id, "PHASE3", "Third entry");

        assert!(result.is_ok());
        let log_path = result.unwrap();
        let content = fs::read_to_string(&log_path).unwrap();

        // All entries should be present
        assert!(content.contains("[PHASE1]"));
        assert!(content.contains("First entry"));
        assert!(content.contains("[PHASE2]"));
        assert!(content.contains("Second entry"));
        assert!(content.contains("[PHASE3]"));
        assert!(content.contains("Third entry"));

        // Cleanup
        let _ = fs::remove_file(log_path);
    }

    #[test]
    fn test_append_to_workflow_log_includes_timestamp() {
        let task_id = "test-timestamp";
        let result = append_to_workflow_log(task_id, "TEST", "Check timestamp");
        assert!(result.is_ok());

        let log_path = result.unwrap();
        let content = fs::read_to_string(&log_path).unwrap();

        // Should have ISO-style timestamp format [YYYY-MM-DD HH:MM:SS.mmm]
        assert!(content.contains("[20"), "Should contain year prefix");

        // Cleanup
        let _ = fs::remove_file(log_path);
    }

    #[test]
    fn test_append_to_workflow_log_multiline_content() {
        let task_id = "test-multiline";
        let multiline = "Line 1\nLine 2\nLine 3";
        let result = append_to_workflow_log(task_id, "MULTI", multiline);
        assert!(result.is_ok());

        let log_path = result.unwrap();
        let content = fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("Line 1\nLine 2\nLine 3"));

        // Cleanup
        let _ = fs::remove_file(log_path);
    }
}
