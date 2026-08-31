use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::state::LocalBackendError;

const DEFAULT_CAPTURE_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub(crate) struct CommandRequest {
    pub(super) action: String,
    pub(super) program: OsString,
    pub(super) args: Vec<OsString>,
    pub(super) env: Vec<(OsString, OsString)>,
    pub(super) env_remove: Vec<OsString>,
    pub(super) timeout: Duration,
    pub(super) max_capture_bytes: usize,
}

impl CommandRequest {
    pub fn new(
        action: impl Into<String>,
        program: impl Into<OsString>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        timeout: Duration,
    ) -> Self {
        Self {
            action: action.into(),
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            env_remove: Vec::new(),
            timeout,
            max_capture_bytes: DEFAULT_CAPTURE_BYTES,
        }
    }

    pub fn with_env_removed(
        mut self,
        names: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        self.env_remove.extend(names.into_iter().map(Into::into));
        self
    }

    pub fn with_env(
        mut self,
        env: impl IntoIterator<Item = (impl Into<OsString>, impl Into<OsString>)>,
    ) -> Self {
        self.env.extend(
            env.into_iter()
                .map(|(name, value)| (name.into(), value.into())),
        );
        self
    }

    #[cfg(test)]
    pub fn args_as_strings(&self) -> Vec<String> {
        self.args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(test)]
    pub fn env_value(&self, name: &str) -> Option<&std::ffi::OsStr> {
        self.env
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_os_str())
    }

    #[cfg(test)]
    pub fn removes_env(&self, name: &str) -> bool {
        self.env_remove.iter().any(|candidate| candidate == name)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct CommandOutput {
    pub(super) success: bool,
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) truncated: bool,
}

impl CommandOutput {
    #[cfg(test)]
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            success: true,
            exit_code: Some(0),
            stdout: stdout.into(),
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub fn failure(exit_code: i32, stderr: impl Into<String>) -> Self {
        Self {
            success: false,
            exit_code: Some(exit_code),
            stderr: stderr.into(),
            ..Self::default()
        }
    }

    pub fn summary(&self) -> String {
        let stdout = self.stdout.trim();
        let stderr = self.stderr.trim();
        let mut summary = match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (false, true) => stdout.to_string(),
            (true, false) => stderr.to_string(),
            (true, true) => "no command output".to_string(),
        };
        if self.truncated {
            summary.push_str("\n[output truncated]");
        }
        summary
    }
}

#[async_trait]
pub(crate) trait ProcessRunner: Send + Sync {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SystemProcessRunner;

#[async_trait]
impl ProcessRunner for SystemProcessRunner {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .envs(request.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in &request.env_remove {
            command.env_remove(name);
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|error| LocalBackendError::CommandFailed {
                action: request.action.clone(),
                status: "could not start".to_string(),
                output: format!("{}: {error}", request.program.to_string_lossy()),
            })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdout_task = tokio::spawn(read_bounded(stdout, request.max_capture_bytes));
        let stderr_task = tokio::spawn(read_bounded(stderr, request.max_capture_bytes));

        let status = match tokio::time::timeout(request.timeout, child.wait()).await {
            Ok(result) => result.map_err(|error| LocalBackendError::CommandFailed {
                action: request.action.clone(),
                status: "could not wait for completion".to_string(),
                output: error.to_string(),
            })?,
            Err(_) => {
                vertebrae_harness_core::signal_process_group(child.id(), true);
                let _ = child.kill().await;
                let _ = child.wait().await;
                let stdout = stdout_task.await.unwrap_or_default();
                let stderr = stderr_task.await.unwrap_or_default();
                let output = CommandOutput {
                    success: false,
                    exit_code: None,
                    stdout: stdout.text,
                    stderr: stderr.text,
                    truncated: stdout.truncated || stderr.truncated,
                };
                return Err(LocalBackendError::CommandTimedOut {
                    action: request.action,
                    timeout_seconds: request.timeout.as_secs(),
                    output: output.summary(),
                });
            }
        };
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();
        Ok(CommandOutput {
            success: status.success(),
            exit_code: status.code(),
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
        })
    }
}

#[derive(Default)]
struct BoundedRead {
    text: String,
    truncated: bool,
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> BoundedRead {
    let mut captured = Vec::with_capacity(limit);
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        captured.extend_from_slice(&buffer[..count]);
        if captured.len() > limit {
            let overflow = captured.len() - limit;
            captured.drain(..overflow);
            truncated = true;
        }
    }
    BoundedRead {
        text: String::from_utf8_lossy(&captured).into_owned(),
        truncated,
    }
}

pub(crate) fn discover_docker_cli() -> Result<PathBuf, LocalBackendError> {
    let path = env::var_os("PATH");
    let home = dirs::home_dir();
    let candidates = standard_docker_candidates();
    resolve_docker_cli(path.as_deref(), home.as_deref(), &candidates)
}

pub(crate) fn path_for_docker_process(
    docker_cli: &Path,
    existing_path: Option<&OsStr>,
) -> OsString {
    let mut path_entries = Vec::new();
    let mut add_path = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !path_entries.iter().any(|entry| entry == &path) {
            path_entries.push(path);
        }
    };

    if let Some(docker_bin_dir) = docker_cli
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        add_path(docker_bin_dir.to_path_buf());
    }
    for candidate in standard_docker_candidates() {
        if let Some(directory) = candidate.parent() {
            add_path(directory.to_path_buf());
        }
    }
    if let Some(existing_path) = existing_path {
        for path in env::split_paths(existing_path) {
            add_path(path);
        }
    }

    env::join_paths(path_entries)
        .unwrap_or_else(|_| existing_path.map(OsStr::to_os_string).unwrap_or_default())
}

fn resolve_docker_cli(
    path: Option<&OsStr>,
    home: Option<&Path>,
    fallback_candidates: &[PathBuf],
) -> Result<PathBuf, LocalBackendError> {
    let executable_name = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    let path_candidates = path
        .into_iter()
        .flat_map(env::split_paths)
        .map(|directory| directory.join(executable_name));
    let home_candidates = home.into_iter().flat_map(|directory| {
        [
            directory.join(".docker/bin").join(executable_name),
            directory.join(".rd/bin").join(executable_name),
            directory.join(".orbstack/bin").join(executable_name),
        ]
    });
    let mut searched = Vec::new();
    for candidate in path_candidates
        .chain(home_candidates)
        .chain(fallback_candidates.iter().cloned())
    {
        searched.push(candidate.display().to_string());
        if is_executable_file(&candidate) {
            return if candidate.is_absolute() {
                Ok(candidate)
            } else {
                env::current_dir()
                    .map(|directory| directory.join(candidate))
                    .map_err(|source| LocalBackendError::FileSystem {
                        action: "resolve Docker CLI from",
                        path: PathBuf::from("."),
                        source,
                    })
            };
        }
    }
    Err(LocalBackendError::DockerCliNotFound {
        searched: searched.join(", "),
    })
}

fn standard_docker_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ];
    #[cfg(target_os = "linux")]
    let candidates = [
        "/usr/bin/docker",
        "/usr/local/bin/docker",
        "/snap/bin/docker",
    ];
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let candidates: [&str; 0] = [];
    candidates.into_iter().map(PathBuf::from).collect()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_runner_bounds_captured_output() {
        let request = CommandRequest::new(
            "emit output",
            "/bin/sh",
            [
                "-c",
                "i=0; while [ \"$i\" -lt 20000 ]; do printf x; i=$((i + 1)); done; printf FINAL",
            ],
            Duration::from_secs(2),
        );

        let output = SystemProcessRunner.run(request).await.expect("run command");

        assert!(output.success);
        assert_eq!(output.stdout.len(), DEFAULT_CAPTURE_BYTES);
        assert!(output.truncated);
        assert!(output.stdout.ends_with("FINAL"));
        assert!(output.summary().ends_with("[output truncated]"));
    }

    #[tokio::test]
    async fn system_runner_kills_timed_out_commands() {
        let request = CommandRequest::new(
            "slow command",
            "/bin/sh",
            ["-c", "printf started; while :; do :; done"],
            Duration::from_millis(20),
        );

        let error = SystemProcessRunner
            .run(request)
            .await
            .expect_err("command should time out");

        assert!(matches!(
            error,
            LocalBackendError::CommandTimedOut { action, .. } if action == "slow command"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_descendant_processes() {
        let temp = tempfile::tempdir().expect("temp dir");
        let marker = temp.path().join("survived");
        let script = format!(
            "(/bin/sleep 0.2; printf survived > '{}') & while :; do :; done",
            marker.display()
        );
        let request = CommandRequest::new(
            "spawn descendant",
            "/bin/sh",
            [OsString::from("-c"), OsString::from(script)],
            Duration::from_millis(20),
        );

        SystemProcessRunner
            .run(request)
            .await
            .expect_err("command should time out");
        tokio::time::sleep(Duration::from_millis(300)).await;

        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn docker_cli_resolution_prefers_path_then_user_and_standard_candidates() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let path_dir = temp.path().join("path");
        let home = temp.path().join("home");
        let standard = temp.path().join("standard/docker");
        fs::create_dir_all(&path_dir).expect("create PATH directory");
        fs::create_dir_all(home.join(".docker/bin")).expect("create user Docker directory");
        fs::create_dir_all(standard.parent().expect("standard parent"))
            .expect("create standard directory");
        for executable in [
            path_dir.join("docker"),
            home.join(".docker/bin/docker"),
            standard.clone(),
        ] {
            fs::write(&executable, "#!/bin/sh\n").expect("write executable");
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
                .expect("make executable");
        }
        let path = env::join_paths([&path_dir]).expect("join PATH");

        assert_eq!(
            resolve_docker_cli(Some(&path), Some(&home), std::slice::from_ref(&standard))
                .expect("resolve PATH Docker"),
            path_dir.join("docker")
        );
        assert_eq!(
            resolve_docker_cli(None, Some(&home), std::slice::from_ref(&standard))
                .expect("resolve user Docker"),
            home.join(".docker/bin/docker")
        );
        fs::remove_file(home.join(".docker/bin/docker")).expect("remove user Docker");
        assert_eq!(
            resolve_docker_cli(None, Some(&home), std::slice::from_ref(&standard))
                .expect("resolve standard Docker"),
            standard
        );
        fs::remove_file(&standard).expect("remove standard Docker");
        assert!(matches!(
            resolve_docker_cli(None, Some(&home), std::slice::from_ref(&standard)),
            Err(LocalBackendError::DockerCliNotFound { .. })
        ));
    }

    #[test]
    fn docker_process_path_prepends_cli_directory_and_preserves_existing_entries() {
        let existing_path = env::join_paths([
            Path::new("/usr/bin"),
            Path::new("/bin"),
            Path::new("/custom/bin"),
        ])
        .expect("join existing PATH");
        let docker_cli = Path::new("/Applications/Docker.app/Contents/Resources/bin/docker");

        let path = path_for_docker_process(docker_cli, Some(&existing_path));

        let entries = env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(
            entries.first(),
            Some(&PathBuf::from(
                "/Applications/Docker.app/Contents/Resources/bin"
            ))
        );
        assert!(entries.contains(&PathBuf::from("/usr/bin")));
        assert!(entries.contains(&PathBuf::from("/bin")));
        assert!(entries.contains(&PathBuf::from("/custom/bin")));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(entries.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn docker_process_path_does_not_duplicate_cli_directory() {
        let existing_path = env::join_paths([
            Path::new("/Applications/Docker.app/Contents/Resources/bin"),
            Path::new("/usr/bin"),
        ])
        .expect("join existing PATH");
        let docker_cli = Path::new("/Applications/Docker.app/Contents/Resources/bin/docker");

        let path = path_for_docker_process(docker_cli, Some(&existing_path));

        let entries = env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| {
                    *entry == Path::new("/Applications/Docker.app/Contents/Resources/bin")
                })
                .count(),
            1
        );
        assert!(entries.contains(&PathBuf::from("/usr/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn docker_cli_resolution_preserves_the_final_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let temp = tempfile::tempdir().expect("temp dir");
        let target = temp.path().join("docker-real");
        let shim = temp.path().join("docker");
        fs::write(&target, "#!/bin/sh\n").expect("write target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700))
            .expect("make target executable");
        symlink(&target, &shim).expect("create Docker shim");

        let resolved = resolve_docker_cli(Some(temp.path().as_os_str()), None, &[])
            .expect("resolve Docker shim");

        assert_eq!(resolved, shim);
        assert!(fs::symlink_metadata(resolved)
            .expect("shim metadata")
            .file_type()
            .is_symlink());
    }
}
