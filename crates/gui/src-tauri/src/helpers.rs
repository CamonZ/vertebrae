use std::path::PathBuf;

/// Find the Claude Code CLI binary
pub fn find_claude_binary() -> Result<PathBuf, String> {
    // Check CLAUDE_CODE_PATH environment variable (highest priority)
    if let Ok(path) = std::env::var("CLAUDE_CODE_PATH") {
        let path = PathBuf::from(path);
        // Verify the path exists
        if path.exists() {
            return Ok(path);
        }
        // If env var is set but path doesn't exist, return early with error
        return Err(format!(
            "Claude binary path specified in CLAUDE_CODE_PATH does not exist: {}",
            path.display()
        ));
    }

    // Try to find 'claude' in PATH
    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let path = PathBuf::from(path_str.trim());
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // Probe well-known installation paths as fallback
    let mut well_known_paths = vec![
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];

    // Add ~/.local/bin/claude (expand ~ to home directory)
    if let Some(home_dir) = dirs::home_dir() {
        well_known_paths.insert(0, home_dir.join(".local/bin/claude"));
    }

    for path in well_known_paths {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(
        "Claude Code CLI not found. Set CLAUDE_CODE_PATH environment variable, ensure 'claude' is in PATH, or install Claude Code in a standard location (~/.local/bin, /usr/local/bin, or /opt/homebrew/bin)"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static CLAUDE_ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_find_claude_binary_with_env_var() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");
        let result = find_claude_binary();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));

        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }

    #[test]
    fn test_find_claude_binary_path_with_spaces() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::set_var("CLAUDE_CODE_PATH", "/bin/sh");
        let result = find_claude_binary();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/sh"));

        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }

    #[test]
    fn test_find_claude_binary_without_env_var() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::remove_var("CLAUDE_CODE_PATH");
        let result = find_claude_binary();
        let _ = result;

        if let Some(v) = original {
            std::env::set_var("CLAUDE_CODE_PATH", v);
        }
    }

    #[test]
    fn test_find_claude_binary_env_var_takes_precedence() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();

        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");
        let result = find_claude_binary();

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));

        std::env::remove_var("CLAUDE_CODE_PATH");
    }

    #[test]
    fn test_find_claude_binary_env_var_nonexistent_returns_error() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::set_var("CLAUDE_CODE_PATH", "/nonexistent/path/to/claude");
        let result = find_claude_binary();

        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(error_msg.contains("does not exist"));

        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }
}
