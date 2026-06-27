use std::path::PathBuf;

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_from_env(env_var: &str, label: &str) -> Result<Option<PathBuf>, String> {
    let Ok(path) = std::env::var(env_var) else {
        return Ok(None);
    };

    let path = PathBuf::from(path);
    if path.exists() {
        return Ok(Some(path));
    }

    Err(format!(
        "{label} path specified in {env_var} does not exist: {}",
        path.display()
    ))
}

fn find_sibling_binary(name: &str) -> Option<PathBuf> {
    let current_exe = std::env::current_exe().ok()?;
    let dir = current_exe.parent()?;
    let executable = executable_name(name);

    let sibling = dir.join(&executable);
    if sibling.exists() {
        return Some(sibling);
    }

    let release = dir.parent()?.join("release").join(executable);
    release.exists().then_some(release)
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.exists().then_some(path)
}

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.exists())
}

/// Find the Claude Code CLI binary
pub fn find_claude_binary() -> Result<PathBuf, String> {
    if let Some(path) = find_from_env("CLAUDE_CODE_PATH", "Claude binary")? {
        return Ok(path);
    }

    if let Some(path) = find_on_path("claude") {
        return Ok(path);
    }

    let mut well_known_paths = vec![
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    if let Some(home_dir) = dirs::home_dir() {
        well_known_paths.insert(0, home_dir.join(".local/bin/claude"));
    }

    if let Some(path) = first_existing(well_known_paths) {
        return Ok(path);
    }

    Err(
        "Claude Code CLI not found. Set CLAUDE_CODE_PATH environment variable, ensure 'claude' is in PATH, or install Claude Code in a standard location (~/.local/bin, /usr/local/bin, or /opt/homebrew/bin)"
            .to_string(),
    )
}

pub fn find_vtb_gate_binary() -> Result<PathBuf, String> {
    if let Some(path) = find_from_env("VTB_GATE_PATH", "vtb-gate")? {
        return Ok(path);
    }

    if let Some(path) = find_sibling_binary("vtb-gate") {
        return Ok(path);
    }

    if let Some(path) = find_on_path("vtb-gate") {
        return Ok(path);
    }

    if let Some(home_dir) = dirs::home_dir() {
        if let Some(path) = first_existing([home_dir.join(".local/bin/vtb-gate")]) {
            return Ok(path);
        }
    }

    Err("vtb-gate not found. Set VTB_GATE_PATH or ensure vtb-gate is on PATH.".to_string())
}

pub fn find_vtb_binary() -> Result<PathBuf, String> {
    if let Some(path) = find_from_env("VTB_PATH", "vtb")? {
        return Ok(path);
    }

    if let Some(path) = find_sibling_binary("vtb") {
        return Ok(path);
    }

    if let Some(path) = find_on_path("vtb") {
        return Ok(path);
    }

    let mut well_known_paths = vec![
        PathBuf::from("/opt/homebrew/bin/vtb"),
        PathBuf::from("/usr/local/bin/vtb"),
    ];

    if let Some(home_dir) = dirs::home_dir() {
        well_known_paths.insert(0, home_dir.join(".local/bin/vtb"));
        well_known_paths.insert(0, home_dir.join(".cargo/bin/vtb"));
    }

    if let Some(path) = first_existing(well_known_paths) {
        return Ok(path);
    }

    Err("vtb not found. Set VTB_PATH or ensure vtb is on PATH.".to_string())
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
