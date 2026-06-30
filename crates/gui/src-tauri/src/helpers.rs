use std::path::PathBuf;

struct BinarySpec {
    display_name: &'static str,
    binary_name: &'static str,
    env_override: &'static str,
    well_known: &'static [&'static str],
    home_relative: &'static str,
}

const CLAUDE_SPEC: BinarySpec = BinarySpec {
    display_name: "Claude Code CLI",
    binary_name: "claude",
    env_override: "CLAUDE_CODE_PATH",
    well_known: &["/usr/local/bin/claude", "/opt/homebrew/bin/claude"],
    home_relative: ".local/bin/claude",
};

const CODEX_SPEC: BinarySpec = BinarySpec {
    display_name: "Codex CLI",
    binary_name: "codex",
    env_override: "CODEX_PATH",
    well_known: &["/usr/local/bin/codex", "/opt/homebrew/bin/codex"],
    home_relative: ".local/bin/codex",
};

/// Find the Claude Code CLI binary
pub fn find_claude_binary() -> Result<PathBuf, String> {
    find_binary(&CLAUDE_SPEC)
}

/// Find the Codex CLI binary.
pub fn find_codex_binary() -> Result<PathBuf, String> {
    find_binary(&CODEX_SPEC)
}

fn find_binary(spec: &BinarySpec) -> Result<PathBuf, String> {
    if let Ok(raw_path) = std::env::var(spec.env_override) {
        let trimmed = raw_path.trim();
        let path = PathBuf::from(trimmed);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "{} path specified in {} does not exist: {}",
            spec.display_name,
            spec.env_override,
            path.display()
        ));
    }

    if let Ok(output) = std::process::Command::new("which")
        .arg(spec.binary_name)
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let path = PathBuf::from(path_str.trim());
            if path.exists() {
                return Ok(path);
            }
        }
    }

    let mut well_known_paths: Vec<_> = spec.well_known.iter().map(PathBuf::from).collect();

    if let Some(home_dir) = dirs::home_dir() {
        well_known_paths.insert(0, home_dir.join(spec.home_relative));
    }

    for path in well_known_paths {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "{} not found. Set {} environment variable, ensure '{}' is in PATH, or install it in a standard location (~/.local/bin, /usr/local/bin, or /opt/homebrew/bin)",
        spec.display_name, spec.env_override, spec.binary_name
    ))
}

pub fn find_vtb_gate_binary() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("VTB_GATE_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "vtb-gate path specified in VTB_GATE_PATH does not exist: {}",
            path.display()
        ));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let sibling = dir.join(if cfg!(windows) {
                "vtb-gate.exe"
            } else {
                "vtb-gate"
            });
            if sibling.exists() {
                return Ok(sibling);
            }
            if let Some(target_dir) = dir.parent() {
                let release = target_dir.join("release").join(if cfg!(windows) {
                    "vtb-gate.exe"
                } else {
                    "vtb-gate"
                });
                if release.exists() {
                    return Ok(release);
                }
            }
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("vtb-gate").output() {
        if output.status.success() {
            let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            if path.exists() {
                return Ok(path);
            }
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        let path = home_dir.join(".local/bin/vtb-gate");
        if path.exists() {
            return Ok(path);
        }
    }

    Err("vtb-gate not found. Set VTB_GATE_PATH or ensure vtb-gate is on PATH.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static BINARY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_find_claude_binary_with_env_var() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

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
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

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
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

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
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");
        let result = find_claude_binary();

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));

        std::env::remove_var("CLAUDE_CODE_PATH");
    }

    #[test]
    fn test_find_claude_binary_env_var_nonexistent_returns_error() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

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

    #[test]
    fn test_find_claude_binary_empty_env_var_returns_error() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CLAUDE_CODE_PATH").ok();

        std::env::set_var("CLAUDE_CODE_PATH", "  ");
        let result = find_claude_binary();

        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(error_msg.contains("does not exist"));
        assert!(error_msg.contains("CLAUDE_CODE_PATH"));

        match original {
            Some(v) => std::env::set_var("CLAUDE_CODE_PATH", v),
            None => std::env::remove_var("CLAUDE_CODE_PATH"),
        }
    }

    #[test]
    fn test_find_codex_binary_with_env_var() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CODEX_PATH").ok();

        std::env::set_var("CODEX_PATH", "/bin/ls");
        let result = find_codex_binary();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));

        match original {
            Some(v) => std::env::set_var("CODEX_PATH", v),
            None => std::env::remove_var("CODEX_PATH"),
        }
    }

    #[test]
    fn test_find_codex_binary_env_var_nonexistent_returns_error() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CODEX_PATH").ok();

        std::env::set_var("CODEX_PATH", "/nonexistent/path/to/codex");
        let result = find_codex_binary();

        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(error_msg.contains("does not exist"));
        assert!(error_msg.contains("CODEX_PATH"));

        match original {
            Some(v) => std::env::set_var("CODEX_PATH", v),
            None => std::env::remove_var("CODEX_PATH"),
        }
    }

    #[test]
    fn test_find_codex_binary_empty_env_var_returns_error() {
        let _lock = BINARY_ENV_MUTEX.lock().unwrap();

        let original = std::env::var("CODEX_PATH").ok();

        std::env::set_var("CODEX_PATH", "  ");
        let result = find_codex_binary();

        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(error_msg.contains("does not exist"));
        assert!(error_msg.contains("CODEX_PATH"));

        match original {
            Some(v) => std::env::set_var("CODEX_PATH", v),
            None => std::env::remove_var("CODEX_PATH"),
        }
    }
}
