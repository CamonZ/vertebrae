use crate::{error::bounded_message, GitHubError};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const GH_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_AUTH_OUTPUT_BYTES: usize = 64 * 1024;

/// Keep the raw token out of diagnostics and serialization.
#[derive(Clone, PartialEq, Eq)]
pub struct GitHubToken(String);

impl GitHubToken {
    pub(crate) fn new(token: impl Into<String>) -> Result<Self, GitHubError> {
        let trimmed = token.into().trim().to_string();
        if trimmed.is_empty() {
            return Err(GitHubError::AuthExpired {
                message: "GitHub token was empty".into(),
            });
        }
        Ok(Self(trimmed))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for GitHubToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GitHubToken([REDACTED])")
    }
}

#[derive(Clone)]
pub struct GhCliAuth {
    env: BTreeMap<String, String>,
    gh_binary: Option<PathBuf>,
    timeout: Duration,
}

impl fmt::Debug for GhCliAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GhCliAuth")
            .field("has_gh_binary", &self.gh_binary.is_some())
            .field("env_var_count", &self.env.len())
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl GhCliAuth {
    pub fn from_env(env: BTreeMap<String, String>) -> Self {
        Self {
            env,
            gh_binary: None,
            timeout: GH_COMMAND_TIMEOUT,
        }
    }

    pub fn with_gh_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.gh_binary = Some(path.into());
        self
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn env_token(&self) -> Option<GitHubToken> {
        ["GH_TOKEN", "GITHUB_TOKEN"]
            .into_iter()
            .find_map(|key| GitHubToken::new(self.env.get(key)?).ok())
    }

    pub async fn resolve(&self) -> Result<GitHubToken, GitHubError> {
        if let Some(token) = self.env_token() {
            return Ok(token);
        }
        let program = self
            .gh_binary
            .as_deref()
            .map_or(OsStr::new("gh"), Path::as_os_str);
        run_gh_auth_token(program, &self.env, self.timeout).await
    }
}

async fn run_gh_auth_token(
    program: &OsStr,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<GitHubToken, GitHubError> {
    let mut cmd = Command::new(program);
    cmd.args(["auth", "token", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(env)
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            GitHubError::GhMissing
        } else {
            GitHubError::GhFailed {
                message: format!("Could not run gh CLI: {err}"),
            }
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let collect = async {
        let (out, err) = tokio::join!(read_bounded(stdout), read_bounded(stderr));
        let status = child.wait().await;
        (out, err, status)
    };

    let (stdout_res, stderr_res, status_res) = match tokio::time::timeout(timeout, collect).await {
        Ok(results) => results,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(GitHubError::GhFailed {
                message: "Timed out waiting for `gh auth token`".into(),
            });
        }
    };

    let pipe_error = |err: std::io::Error| GitHubError::GhFailed {
        message: format!("Could not read `gh auth token` output: {err}"),
    };
    let status = status_res.map_err(|err| GitHubError::GhFailed {
        message: format!("Failed waiting for `gh auth token`: {err}"),
    })?;
    let stdout_bytes = stdout_res.map_err(pipe_error)?;
    let stderr_bytes = stderr_res.map_err(pipe_error)?;

    if !status.success() {
        let stderr_text = bounded_message(&String::from_utf8_lossy(&stderr_bytes));
        let message = if stderr_text.is_empty() {
            "Not logged into GitHub CLI. Run `gh auth login` in your terminal.".into()
        } else {
            stderr_text
        };
        return Err(GitHubError::AuthExpired { message });
    }

    let token_str = String::from_utf8(stdout_bytes).map_err(|_| GitHubError::GhFailed {
        message: "`gh auth token` returned non-UTF-8 output".into(),
    })?;
    GitHubToken::new(token_str)
}

async fn read_bounded<R: AsyncRead + Unpin>(pipe: Option<R>) -> Result<Vec<u8>, std::io::Error> {
    let mut buf = Vec::new();
    if let Some(pipe) = pipe {
        pipe.take(MAX_AUTH_OUTPUT_BYTES as u64)
            .read_to_end(&mut buf)
            .await?;
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_with_token_vars(vars: &[(&str, &str)]) -> GhCliAuth {
        GhCliAuth::from_env(
            vars.iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        )
    }

    #[test]
    fn token_debug_is_always_redacted() {
        let secret = "ghp_synthetic_test_token_1234567890";
        let token = GitHubToken::new(secret).unwrap();
        let rendered = format!("{token:?}");
        assert_eq!(rendered, "GitHubToken([REDACTED])");
        assert!(!rendered.contains(secret));
    }

    #[test]
    fn gh_cli_auth_debug_never_exposes_env_secrets() {
        let auth = auth_with_token_vars(&[
            ("GH_TOKEN", "gho_synthetic_secret_gh"),
            ("GITHUB_TOKEN", "ghp_synthetic_secret_github"),
            ("OTHER_API_KEY", "sk_synthetic_secret_other"),
        ]);
        let rendered = format!("{auth:?}");
        assert!(!rendered.contains("gho_synthetic_secret_gh"));
        assert!(!rendered.contains("ghp_synthetic_secret_github"));
        assert!(!rendered.contains("sk_synthetic_secret_other"));
        assert!(!rendered.contains("GH_TOKEN"));
        assert!(!rendered.contains("OTHER_API_KEY"));
    }

    #[tokio::test]
    async fn env_token_precedence_prefers_gh_token_over_github_token() {
        let token = auth_with_token_vars(&[
            ("GH_TOKEN", "gho_from_gh_token"),
            ("GITHUB_TOKEN", "gho_from_github_token"),
        ])
        .resolve()
        .await
        .unwrap();
        assert_eq!(token.expose(), "gho_from_gh_token");
    }

    #[tokio::test]
    async fn env_token_falls_back_to_github_token() {
        let token = auth_with_token_vars(&[
            ("GH_TOKEN", "   "),
            ("GITHUB_TOKEN", "gho_from_github_token"),
        ])
        .resolve()
        .await
        .unwrap();
        assert_eq!(token.expose(), "gho_from_github_token");
    }

    #[tokio::test]
    async fn missing_gh_binary_returns_gh_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(dir.path().join("gh"))
            .resolve()
            .await
            .unwrap_err();
        assert_eq!(err, GitHubError::GhMissing);
    }

    #[cfg(unix)]
    fn fake_gh(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let script = dir.join(name);
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_cli_success_passes_hostname_and_failure_maps_to_auth_expired() {
        let dir = tempfile::tempdir().unwrap();
        let ok_script = fake_gh(
            dir.path(),
            "gh-ok",
            r#"[ "$*" = "auth token --hostname github.com" ] || { echo "unexpected args: $*" >&2; exit 2; }
echo gho_synthetic_cli_token"#,
        );
        let token = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&ok_script)
            .resolve()
            .await
            .unwrap();
        assert_eq!(token.expose(), "gho_synthetic_cli_token");

        let fail_script = fake_gh(
            dir.path(),
            "gh-fail",
            "echo 'no oauth token found' >&2\nexit 1",
        );
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&fail_script)
            .resolve()
            .await
            .unwrap_err();
        assert_eq!(
            err,
            GitHubError::AuthExpired {
                message: "no oauth token found".into(),
            }
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_cli_timeout_kills_child_and_reports_gh_failed() {
        let dir = tempfile::tempdir().unwrap();
        let slow = fake_gh(dir.path(), "gh-slow", "exec sleep 30");
        let started = std::time::Instant::now();
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&slow)
            .with_timeout(Duration::from_millis(200))
            .resolve()
            .await
            .unwrap_err();
        assert!(
            matches!(err, GitHubError::GhFailed { ref message } if message.contains("Timed out"))
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_cli_non_executable_binary_and_bad_output_report_gh_failed() {
        let dir = tempfile::tempdir().unwrap();
        let not_executable = dir.path().join("gh-plain");
        std::fs::write(&not_executable, "not a program").unwrap();
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&not_executable)
            .resolve()
            .await
            .unwrap_err();
        assert!(matches!(err, GitHubError::GhFailed { .. }), "{err:?}");

        let non_utf8 = fake_gh(dir.path(), "gh-binary-output", r"printf '\377\376'");
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&non_utf8)
            .resolve()
            .await
            .unwrap_err();
        assert!(
            matches!(err, GitHubError::GhFailed { ref message } if message.contains("non-UTF-8")),
            "{err:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_cli_stderr_is_truncated_in_auth_error() {
        let dir = tempfile::tempdir().unwrap();
        let noisy = fake_gh(
            dir.path(),
            "gh-noisy",
            "i=0; while [ $i -lt 2000 ]; do printf x >&2; i=$((i+1)); done; exit 1",
        );
        let err = GhCliAuth::from_env(BTreeMap::new())
            .with_gh_binary(&noisy)
            .resolve()
            .await
            .unwrap_err();
        match err {
            GitHubError::AuthExpired { message } => assert!(message.chars().count() <= 301),
            other => panic!("expected AuthExpired, got {other:?}"),
        }
    }
}
