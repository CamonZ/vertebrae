use std::path::{Path, PathBuf};

use vertebrae_core::Provider;

/// Resolved provider binaries (best-effort, per-startup).
///
/// Each entry is `Some` when the binary was found at daemon-startup PATH /
/// env-override resolution, `None` otherwise. A missing binary does not
/// prevent the daemon from starting — only steps that request that provider
/// will fail during shared harness construction before spawn.
#[derive(Debug, Clone, Default)]
pub struct ProviderBinaries {
    pub anthropic: Option<PathBuf>,
    pub openai: Option<PathBuf>,
}

/// Best-effort diagnostics captured alongside [`ProviderBinaries`].
#[derive(Debug, Clone, Default)]
pub struct ProviderDiscoveryDiagnostics {
    pub anthropic: Option<String>,
    pub openai: Option<String>,
}

impl ProviderBinaries {
    /// Return the resolved binary for `provider`, or `None` if it was not
    /// found at daemon startup.
    pub fn get(&self, provider: Provider) -> Option<&Path> {
        match provider {
            Provider::Anthropic => self.anthropic.as_deref(),
            Provider::Openai => self.openai.as_deref(),
        }
    }
}

/// Resolve all known provider binaries from PATH / env overrides.
///
/// Missing binaries are represented as `None` — the daemon still starts so a
/// single missing provider doesn't block other workflows. Each missing one
/// is logged at WARN with the underlying resolution error so operators get
/// a clear hint.
pub fn resolve_all_provider_binaries(shell_path: &str) -> ProviderBinaries {
    resolve_all_provider_binaries_with_diagnostics(shell_path).0
}

/// Resolve every built-in provider and retain the failure diagnostics for the
/// daemon startup capability snapshot.
pub fn resolve_all_provider_binaries_with_diagnostics(
    shell_path: &str,
) -> (ProviderBinaries, ProviderDiscoveryDiagnostics) {
    let (anthropic, anthropic_diagnostic) = match find_claude_binary(shell_path) {
        Ok(path) => (Some(path), None),
        Err(err) => {
            tracing::warn!(
                provider = %Provider::Anthropic,
                error = %err,
                "Anthropic provider binary not resolved at startup; steps requesting it will fail"
            );
            (None, Some(err))
        }
    };
    let (openai, openai_diagnostic) = match find_codex_binary(shell_path) {
        Ok(path) => (Some(path), None),
        Err(err) => {
            tracing::warn!(
                provider = %Provider::Openai,
                error = %err,
                "OpenAI provider binary not resolved at startup; steps requesting it will fail"
            );
            (None, Some(err))
        }
    };
    (
        ProviderBinaries { anthropic, openai },
        ProviderDiscoveryDiagnostics {
            anthropic: anthropic_diagnostic,
            openai: openai_diagnostic,
        },
    )
}

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

/// Static metadata describing how to locate a built-in provider's CLI.
struct BinarySpec {
    /// Human-readable name used in error messages (e.g. "Claude Code CLI").
    display_name: &'static str,
    /// Executable name as it appears on PATH (e.g. "claude").
    binary_name: &'static str,
    /// Environment variable that, when set, takes precedence over PATH lookups.
    env_override: &'static str,
    /// Well-known absolute installation paths (probed after PATH lookup fails).
    well_known: &'static [&'static str],
    /// Subpath under `$HOME` to also probe (e.g. `.local/bin/claude`).
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

/// Resolution order:
/// 1. `spec.env_override` env var (must point to an existing file)
/// 2. Lookup in the provided `shell_path` directories
/// 3. Well-known installation paths: `~/.local/bin/<binary>`, `/usr/local/bin/<binary>`,
///    `/opt/homebrew/bin/<binary>`
fn find_binary(spec: &BinarySpec, shell_path: &str) -> Result<PathBuf, String> {
    // An exported-but-blank env var falls through to PATH lookup rather than
    // erroring, so users can leave the var defined in their shell rc.
    if let Ok(raw) = std::env::var(spec.env_override) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
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
    }

    for dir in shell_path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join(spec.binary_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let well_known = home
        .into_iter()
        .map(|h| PathBuf::from(h).join(spec.home_relative))
        .chain(spec.well_known.iter().map(PathBuf::from));
    for path in well_known {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "{} not found. Set {} environment variable, ensure '{}' is in PATH, or install {} in a standard location (~/.local/bin, /usr/local/bin, or /opt/homebrew/bin)",
        spec.display_name, spec.env_override, spec.binary_name, spec.display_name,
    ))
}

/// Find the Claude Code CLI binary.
///
/// See [`find_binary`] for resolution order. Honors `CLAUDE_CODE_PATH`.
pub fn find_claude_binary(shell_path: &str) -> Result<PathBuf, String> {
    find_binary(&CLAUDE_SPEC, shell_path)
}

/// Find the Codex CLI binary.
///
/// See [`find_binary`] for resolution order. Honors `CODEX_PATH`.
pub fn find_codex_binary(shell_path: &str) -> Result<PathBuf, String> {
    find_binary(&CODEX_SPEC, shell_path)
}

/// Find the binary for a built-in [`Provider`].
///
/// Errors are scoped to the requested provider so a user choosing OpenAI
/// gets a Codex-specific error instead of a Claude-specific one.
pub fn find_provider_binary(provider: Provider, shell_path: &str) -> Result<PathBuf, String> {
    match provider {
        Provider::Anthropic => find_claude_binary(shell_path),
        Provider::Openai => find_codex_binary(shell_path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// Serializes all tests that mutate process-wide env vars (HOME,
    /// CLAUDE_CODE_PATH, CODEX_PATH). Without this guard parallel test
    /// runners would race each other through `set_var`/`remove_var`.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Lock the env mutex even if a previous test panicked while holding
    /// it. The state we care about is restored by [`EnvGuard::drop`], so
    /// recovering from poisoning is safe.
    fn env_lock() -> MutexGuard<'static, ()> {
        match ENV_MUTEX.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Save the current value of an env var and restore it on drop. Lets
    /// tests mutate env vars without leaking state between runs.
    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn capture(key: &'static str) -> Self {
            Self {
                key,
                original: std::env::var(key).ok(),
            }
        }

        fn set(&self, value: &str) {
            // SAFETY: tests are serialized by ENV_MUTEX above.
            unsafe { std::env::set_var(self.key, value) };
        }

        fn remove(&self) {
            // SAFETY: tests are serialized by ENV_MUTEX above.
            unsafe { std::env::remove_var(self.key) };
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                // SAFETY: tests are serialized by ENV_MUTEX above.
                Some(v) => unsafe { std::env::set_var(self.key, v) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }

    /// Test-only spec with no on-disk well-known paths. Lets us exercise
    /// the "binary not found" branch deterministically on machines that
    /// might happen to have a real `claude`/`codex` installed at the
    /// production well-known paths.
    fn synthetic_spec(name: &'static str, env: &'static str) -> BinarySpec {
        BinarySpec {
            display_name: name,
            binary_name: name,
            env_override: env,
            well_known: &[],
            home_relative: "vtb-test-nonexistent-bin",
        }
    }

    #[test]
    fn resolve_shell_path_returns_non_empty() {
        let path = resolve_shell_path();
        assert!(!path.is_empty());
        // Should contain at least the standard system dirs
        assert!(path.contains("/usr/bin") || path.contains("/bin"));
    }

    // ===== Claude binary discovery =====

    #[test]
    fn claude_env_var_existing_path_returns_ok() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        let _h = EnvGuard::capture("HOME");
        g.set("/bin/ls");

        let result = find_claude_binary("/usr/bin:/bin");
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));
    }

    #[test]
    fn claude_env_var_nonexistent_path_returns_error() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        g.set("/nonexistent/path/to/claude");

        let err = find_claude_binary("/usr/bin:/bin").unwrap_err();
        assert!(err.contains("does not exist"), "err was: {err}");
        assert!(err.contains("CLAUDE_CODE_PATH"), "err was: {err}");
    }

    // ===== Codex binary discovery =====

    #[test]
    fn codex_env_var_existing_path_returns_ok() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CODEX_PATH");
        g.set("/bin/ls");

        let result = find_codex_binary("/usr/bin:/bin");
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));
    }

    #[test]
    fn codex_env_var_nonexistent_path_returns_error() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CODEX_PATH");
        g.set("/nonexistent/path/to/codex");

        let err = find_codex_binary("/usr/bin:/bin").unwrap_err();
        assert!(err.contains("does not exist"), "err was: {err}");
        assert!(err.contains("CODEX_PATH"), "err was: {err}");
    }

    // ===== find_provider_binary dispatch =====
    //
    // The success-path tests use `*_PATH` env overrides pointing at
    // `/bin/ls` so they don't depend on whether claude/codex are installed
    // on the host. The "missing binary" tests use a synthetic `BinarySpec`
    // that has no well-known paths so the failure branch is reachable on
    // hosts that do have a real claude/codex installed.

    #[test]
    fn provider_binary_anthropic_uses_claude_lookup() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        let _c = EnvGuard::capture("CODEX_PATH");
        g.set("/bin/ls");

        let result = find_provider_binary(Provider::Anthropic, "/usr/bin:/bin");
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));
    }

    #[test]
    fn provider_binary_openai_uses_codex_lookup() {
        let _lock = env_lock();
        let _c = EnvGuard::capture("CLAUDE_CODE_PATH");
        let g = EnvGuard::capture("CODEX_PATH");
        g.set("/bin/ls");

        let result = find_provider_binary(Provider::Openai, "/usr/bin:/bin");
        assert_eq!(result.unwrap(), PathBuf::from("/bin/ls"));
    }

    /// When the requested provider's env override and PATH lookup both
    /// fail, the error must be scoped to the requested provider's CLI even
    /// if the *other* provider's CLI happens to be installed.
    #[test]
    fn synthetic_anthropic_missing_binary_error_is_provider_scoped() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        let h = EnvGuard::capture("HOME");
        g.remove();
        h.set("/nonexistent");

        let spec = synthetic_spec("Claude Code CLI", "CLAUDE_CODE_PATH");
        let err = find_binary(&spec, "/nonexistent/dir").unwrap_err();
        assert!(err.contains("Claude Code CLI"), "got: {err}");
        assert!(err.contains("CLAUDE_CODE_PATH"), "got: {err}");
        // Must not leak the other provider's binary name into the error.
        assert!(!err.to_lowercase().contains("codex"), "got: {err}");
    }

    #[test]
    fn synthetic_openai_missing_binary_error_is_provider_scoped() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CODEX_PATH");
        let h = EnvGuard::capture("HOME");
        g.remove();
        h.set("/nonexistent");

        let spec = synthetic_spec("Codex CLI", "CODEX_PATH");
        let err = find_binary(&spec, "/nonexistent/dir").unwrap_err();
        assert!(err.contains("Codex CLI"), "got: {err}");
        assert!(err.contains("CODEX_PATH"), "got: {err}");
        assert!(!err.to_lowercase().contains("claude"), "got: {err}");
    }

    #[test]
    fn synthetic_blank_env_var_falls_through_to_path_lookup() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        let h = EnvGuard::capture("HOME");
        g.set("   ");
        h.set("/nonexistent");

        // Synthetic spec has no well-known paths and HOME is bogus, so we
        // must hit the not-found branch -- not the "does not exist" branch
        // that would fire only if the env var had been treated as set.
        let spec = synthetic_spec("Claude Code CLI", "CLAUDE_CODE_PATH");
        let err = find_binary(&spec, "/nonexistent/dir").unwrap_err();
        assert!(!err.contains("does not exist"), "got: {err}");
        assert!(err.contains("Claude Code CLI not found"), "got: {err}");
    }

    /// Confirms env-var precedence works the same way for both built-in
    /// providers without depending on whichever binary the host has.
    #[test]
    fn env_var_takes_precedence_over_path_lookup() {
        let _lock = env_lock();
        let g = EnvGuard::capture("CLAUDE_CODE_PATH");
        g.set("/bin/ls");

        // Even with a /usr/bin path that *might* contain a real `claude`,
        // the env override wins.
        let result = find_claude_binary("/usr/bin:/bin").unwrap();
        assert_eq!(result, PathBuf::from("/bin/ls"));
    }
}
