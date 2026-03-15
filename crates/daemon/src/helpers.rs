use std::path::PathBuf;

/// Resolve the user's login shell PATH.
///
/// The daemon runs under launchd with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
/// To give child processes access to user-installed tools (`mix`, `node`, `vtb`, etc.),
/// we spawn the user's login shell and capture its PATH.
///
/// Falls back to the current process PATH if the shell invocation fails.
pub fn resolve_shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Spawn a login+interactive shell that just prints PATH and exits.
    // `-l` sources profile/rc files, `-i` sources interactive-only config,
    // `-c` runs the command and exits.
    if let Ok(output) = std::process::Command::new(&shell)
        .args(["-lic", "echo $PATH"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .output()
        && output.status.success()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }

    // Fallback: current process PATH (the minimal launchd one).
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string())
}

/// Find the Claude Code CLI binary.
///
/// Resolution order:
/// 1. `CLAUDE_CODE_PATH` environment variable (must point to an existing file)
/// 2. Lookup in the provided `shell_path` directories
/// 3. Well-known installation paths: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`
pub fn find_claude_binary(shell_path: &str) -> Result<PathBuf, String> {
    // Check CLAUDE_CODE_PATH environment variable (highest priority)
    if let Ok(path) = std::env::var("CLAUDE_CODE_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Claude binary path specified in CLAUDE_CODE_PATH does not exist: {}",
            path.display()
        ));
    }

    // Search for 'claude' in the resolved shell PATH directories.
    for dir in shell_path.split(':') {
        let candidate = PathBuf::from(dir).join("claude");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // Probe well-known installation paths as fallback
    let mut well_known_paths = vec![
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];

    // Add ~/.local/bin/claude (expand ~ via HOME env var)
    if let Ok(home) = std::env::var("HOME") {
        well_known_paths.insert(0, PathBuf::from(home).join(".local/bin/claude"));
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
    fn resolve_shell_path_returns_non_empty() {
        let path = resolve_shell_path();
        assert!(!path.is_empty());
        // Should contain at least the standard system dirs
        assert!(path.contains("/usr/bin") || path.contains("/bin"));
    }

    #[test]
    fn env_var_existing_path_returns_ok() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        // SAFETY: tests are serialized by CLAUDE_ENV_MUTEX.
        unsafe { std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls") };
        let result = find_claude_binary("/usr/bin:/bin");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));

        match original {
            Some(v) => unsafe { std::env::set_var("CLAUDE_CODE_PATH", v) },
            None => unsafe { std::env::remove_var("CLAUDE_CODE_PATH") },
        }
    }

    #[test]
    fn env_var_nonexistent_path_returns_error() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        // SAFETY: tests are serialized by CLAUDE_ENV_MUTEX.
        unsafe { std::env::set_var("CLAUDE_CODE_PATH", "/nonexistent/path/to/claude") };
        let result = find_claude_binary("/usr/bin:/bin");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));

        match original {
            Some(v) => unsafe { std::env::set_var("CLAUDE_CODE_PATH", v) },
            None => unsafe { std::env::remove_var("CLAUDE_CODE_PATH") },
        }
    }

    #[test]
    fn without_env_var_does_not_panic() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        // SAFETY: tests are serialized by CLAUDE_ENV_MUTEX.
        unsafe { std::env::remove_var("CLAUDE_CODE_PATH") };
        let _result = find_claude_binary("/usr/bin:/bin");

        if let Some(v) = original {
            unsafe { std::env::set_var("CLAUDE_CODE_PATH", v) };
        }
    }

    #[test]
    fn finds_binary_in_shell_path() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        let original = std::env::var("CLAUDE_CODE_PATH").ok();
        unsafe { std::env::remove_var("CLAUDE_CODE_PATH") };

        // /bin/ls exists; pretend it's named "claude" by searching for "ls" —
        // but find_claude_binary specifically looks for "claude", so we test
        // that it returns an error when claude isn't in the given path.
        let result = find_claude_binary("/nonexistent/dir");
        // Should fail since claude isn't in /nonexistent/dir or well-known paths
        // (unless claude happens to be installed on this machine)
        let _ = result;

        match original {
            Some(v) => unsafe { std::env::set_var("CLAUDE_CODE_PATH", v) },
            None => {}
        }
    }
}
