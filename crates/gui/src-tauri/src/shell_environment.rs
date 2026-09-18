use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};

const ENV_START_MARKER: &[u8] = b"__VERTEBRAE_SHELL_ENV_START__";
const ENV_END_MARKER: &[u8] = b"__VERTEBRAE_SHELL_ENV_END__";
const CAPTURE_COMMAND: &str = "printf '\\n__VERTEBRAE_SHELL_ENV_START__\\n'; env -0; printf '\\n__VERTEBRAE_SHELL_ENV_END__\\n'";

/// Environment exported by the user's login+interactive shell.
///
/// The shell is allowed to apply its native startup-file rules exactly once.
/// In particular, zsh applies `.zprofile` before `.zshrc`, while bash applies
/// its normal login profile precedence (`.bash_profile`, `.bash_login`, then
/// `.profile`) and lets that profile decide whether to source `.bashrc`.
/// We deliberately do not source any of those files a second time ourselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellEnvironment {
    pub(crate) variables: BTreeMap<String, String>,
    pub(crate) path: String,
    pub(crate) diagnostic: Option<String>,
}

impl ShellEnvironment {
    fn fallback(variables: BTreeMap<String, String>, diagnostic: Option<String>) -> Self {
        let path = variables.get("PATH").cloned().unwrap_or_default();
        Self {
            variables,
            path,
            diagnostic,
        }
    }

    fn from_captured(
        mut variables: BTreeMap<String, String>,
        inherited: &BTreeMap<String, String>,
    ) -> Self {
        let path = variables.get("PATH").cloned().unwrap_or_default();

        // These variables are explicit executable overrides. A startup file
        // may export a different value, but it must not silently replace a
        // value that was already supplied to the GUI process.
        for key in ["CLAUDE_CODE_PATH", "CODEX_PATH", "VTB_GATE_PATH"] {
            if let Some(value) = inherited.get(key) {
                variables.insert(key.to_string(), value.clone());
            }
        }

        Self {
            variables,
            path,
            diagnostic: None,
        }
    }
}

static USER_SHELL_ENVIRONMENT: OnceLock<ShellEnvironment> = OnceLock::new();

/// Return the process-wide shell snapshot used by local chat.
///
/// Local-chat initialization can discover provider binaries, build capability
/// catalogs, and create sessions through separate code paths. Caching the
/// snapshot keeps those paths from repeatedly executing user startup files.
pub(crate) fn user_shell_environment() -> ShellEnvironment {
    USER_SHELL_ENVIRONMENT
        .get_or_init(load_current_shell_environment)
        .clone()
}

fn load_current_shell_environment() -> ShellEnvironment {
    let inherited = env::vars().collect::<BTreeMap<_, _>>();
    let shell = env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_shell);
    load_from_shell(&shell, &inherited)
}

#[cfg(unix)]
fn default_shell() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/bin/zsh")
    } else {
        PathBuf::from("/bin/bash")
    }
}

#[cfg(not(unix))]
fn default_shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}

fn load_from_shell(shell: &Path, inherited: &BTreeMap<String, String>) -> ShellEnvironment {
    let shell_args = if shell
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("zsh"))
    {
        // Keep this snapshot scoped to the user's files. The system zsh
        // profile can rewrite PATH for the GUI's launch context and is not a
        // user startup file we need to source here.
        ["-dilc", CAPTURE_COMMAND]
    } else {
        ["-ilc", CAPTURE_COMMAND]
    };
    let output = Command::new(shell)
        .args(shell_args)
        .env_clear()
        .envs(inherited)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Startup diagnostics must not become part of the provider protocol.
        .stderr(Stdio::null())
        .output();

    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return ShellEnvironment::fallback(
                inherited.clone(),
                Some(format!(
                    "shell startup command {} exited with {}",
                    shell.display(),
                    output
                        .status
                        .code()
                        .map_or_else(|| "a signal".to_string(), |code| code.to_string())
                )),
            );
        }
        Err(error) => {
            return ShellEnvironment::fallback(
                inherited.clone(),
                Some(format!(
                    "failed to load shell startup command {}: {error}",
                    shell.display()
                )),
            );
        }
    };

    let Some(payload) = framed_environment(&output.stdout) else {
        return ShellEnvironment::fallback(
            inherited.clone(),
            Some(format!(
                "shell startup command {} did not produce a complete environment snapshot",
                shell.display()
            )),
        );
    };

    let variables = parse_environment(payload).unwrap_or_else(|| inherited.clone());
    ShellEnvironment::from_captured(variables, inherited)
}

fn framed_environment(output: &[u8]) -> Option<&[u8]> {
    let start = output
        .windows(ENV_START_MARKER.len())
        .position(|window| window == ENV_START_MARKER)?;
    let payload_start = start + ENV_START_MARKER.len();
    let end = output[payload_start..]
        .windows(ENV_END_MARKER.len())
        .position(|window| window == ENV_END_MARKER)?
        + payload_start;
    Some(&output[payload_start..end])
}

fn parse_environment(payload: &[u8]) -> Option<BTreeMap<String, String>> {
    let payload = payload.strip_prefix(b"\n").unwrap_or(payload);
    let payload = payload.strip_suffix(b"\n").unwrap_or(payload);
    let mut variables = BTreeMap::new();
    for entry in payload.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let separator = entry.iter().position(|byte| *byte == b'=')?;
        let key = std::str::from_utf8(&entry[..separator]).ok()?;
        let value = std::str::from_utf8(&entry[separator + 1..]).ok()?;
        if key.is_empty() {
            return None;
        }
        variables.insert(key.to_string(), value.to_string());
    }
    Some(variables)
}

#[cfg(test)]
pub(crate) fn load_shell_environment_for_tests(
    shell: &Path,
    inherited: BTreeMap<String, String>,
) -> ShellEnvironment {
    load_from_shell(shell, &inherited)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use tempfile::tempdir;

    fn unix_shell(name: &str) -> Option<PathBuf> {
        let shell = PathBuf::from("/bin").join(name);
        shell.is_file().then_some(shell)
    }

    fn inherited(home: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("CLAUDE_CODE_PATH".into(), "/explicit/claude".into()),
        ])
    }

    #[test]
    fn zsh_loads_profile_then_rc_and_ignores_startup_output() {
        let Some(shell) = unix_shell("zsh") else {
            return;
        };
        let home = tempdir().unwrap();
        fs::write(
            home.path().join(".zprofile"),
            "export VTB_SHELL_FILE_TEST=profile\nexport PATH=\"$HOME/profile/bin:$PATH\"\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".zshrc"),
            "printf 'startup output that must not be parsed\\n'\nexport VTB_SHELL_FILE_TEST=rc\nexport PATH=\"$HOME/rc/bin:$PATH\"\nexport CLAUDE_CODE_PATH=/startup/claude\n",
        )
        .unwrap();

        let environment = load_shell_environment_for_tests(&shell, inherited(home.path()));

        assert_eq!(
            environment.variables.get("VTB_SHELL_FILE_TEST"),
            Some(&"rc".to_string())
        );
        assert!(environment.path.starts_with(&format!(
            "{}/rc/bin:{}/profile/bin:",
            home.path().display(),
            home.path().display()
        )));
        assert_eq!(
            environment.variables.get("CLAUDE_CODE_PATH"),
            Some(&"/explicit/claude".to_string())
        );
        assert!(environment.diagnostic.is_none());
    }

    #[test]
    fn bash_uses_bash_profile_before_bashrc_without_falling_back_to_profile() {
        let Some(shell) = unix_shell("bash") else {
            return;
        };
        let home = tempdir().unwrap();
        fs::write(
            home.path().join(".profile"),
            "export VTB_BASH_FILE_TEST=profile-fallback\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".bash_profile"),
            "export VTB_BASH_FILE_TEST=bash-profile\n. \"$HOME/.bashrc\"\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".bashrc"),
            "printf 'bash startup output that must not be parsed\\n'\nexport VTB_BASH_RC_TEST=loaded\nexport PATH=\"$HOME/bashrc/bin:$PATH\"\n",
        )
        .unwrap();

        let environment = load_shell_environment_for_tests(&shell, inherited(home.path()));

        assert_eq!(
            environment.variables.get("VTB_BASH_FILE_TEST"),
            Some(&"bash-profile".to_string())
        );
        assert_eq!(
            environment.variables.get("VTB_BASH_RC_TEST"),
            Some(&"loaded".to_string())
        );
        assert!(environment
            .path
            .starts_with(&format!("{}/bashrc/bin:", home.path().display())));
        assert!(environment.diagnostic.is_none());
    }

    #[test]
    fn missing_startup_files_keep_the_inherited_environment() {
        let Some(shell) = unix_shell("zsh") else {
            return;
        };
        let home = tempdir().unwrap();

        let environment = load_shell_environment_for_tests(&shell, inherited(home.path()));

        assert_eq!(environment.path, "/usr/bin:/bin");
        assert_eq!(
            environment.variables.get("CLAUDE_CODE_PATH"),
            Some(&"/explicit/claude".to_string())
        );
        assert!(environment.diagnostic.is_none());
    }

    #[test]
    fn shell_startup_failure_falls_back_without_exposing_shell_output() {
        let Some(shell) = unix_shell("zsh") else {
            return;
        };
        let home = tempdir().unwrap();
        fs::write(
            home.path().join(".zshrc"),
            "printf 'startup failure output\\n' >&2\nexit 17\n",
        )
        .unwrap();

        let environment = load_shell_environment_for_tests(&shell, inherited(home.path()));

        assert_eq!(environment.path, "/usr/bin:/bin");
        assert!(environment
            .diagnostic
            .as_deref()
            .is_some_and(|diagnostic| diagnostic.contains("17")));
        assert!(!environment
            .variables
            .values()
            .any(|value| value.contains("startup failure output")));
    }

    #[test]
    fn malformed_or_unframed_output_is_rejected() {
        assert!(framed_environment(b"noise").is_none());
        assert!(parse_environment(b"not-an-environment-entry\0").is_none());
    }
}
