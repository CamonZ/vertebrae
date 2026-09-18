use std::{collections::BTreeMap, ffi::OsStr, path::PathBuf};

use crate::shell_environment::{user_shell_environment, ShellEnvironment};

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
    let shell_environment = user_shell_environment();
    find_binary(
        &CLAUDE_SPEC,
        &shell_environment.path,
        Some(&shell_environment.variables),
    )
}

/// Find the Codex CLI binary.
pub fn find_codex_binary() -> Result<PathBuf, String> {
    let shell_environment = user_shell_environment();
    find_binary(
        &CODEX_SPEC,
        &shell_environment.path,
        Some(&shell_environment.variables),
    )
}

pub(crate) fn find_claude_binary_with_shell_environment(
    shell_environment: &ShellEnvironment,
) -> Result<PathBuf, String> {
    find_binary(
        &CLAUDE_SPEC,
        &shell_environment.path,
        Some(&shell_environment.variables),
    )
}

pub(crate) fn find_codex_binary_with_shell_environment(
    shell_environment: &ShellEnvironment,
) -> Result<PathBuf, String> {
    find_binary(
        &CODEX_SPEC,
        &shell_environment.path,
        Some(&shell_environment.variables),
    )
}

/// Build an augmented PATH that prepends commonly needed directories for macOS GUI apps.
pub fn build_augmented_path() -> String {
    build_augmented_path_from(&user_shell_environment().path)
}

pub(crate) fn build_augmented_path_from(current_path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".cargo/bin").to_string_lossy().into_owned());
        parts.push(home.join(".local/bin").to_string_lossy().into_owned());
    }

    parts.push("/opt/homebrew/bin".to_string());
    parts.push("/usr/local/bin".to_string());

    if !current_path.is_empty() {
        parts.push(current_path.to_string());
    }

    parts.join(":")
}

fn find_binary(
    spec: &BinarySpec,
    search_path: &str,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<PathBuf, String> {
    if let Some(raw_path) = std::env::var(spec.env_override)
        .ok()
        .or_else(|| environment.and_then(|environment| environment.get(spec.env_override).cloned()))
    {
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

    for directory in std::env::split_paths(OsStr::new(search_path)) {
        let path = directory.join(spec.binary_name);
        if path.is_file() {
            return Ok(path);
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
    find_vtb_gate_binary_with_shell_environment(&user_shell_environment())
}

pub(crate) fn find_vtb_gate_binary_with_shell_environment(
    shell_environment: &ShellEnvironment,
) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var("VTB_GATE_PATH")
        .ok()
        .or_else(|| shell_environment.variables.get("VTB_GATE_PATH").cloned())
    {
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

    for directory in std::env::split_paths(OsStr::new(&shell_environment.path)) {
        let path = directory.join("vtb-gate");
        if path.is_file() {
            return Ok(path);
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
