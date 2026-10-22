//! Provider identity is persisted separately from its executable path. Missing
//! identity means Docker Compose for compatibility with existing schema-2 state.
use super::*;
use std::path::Path;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposeProviderKind {
    #[default]
    DockerCompose,
    PodmanCompose,
}

pub(crate) fn discover_provider(
    mut discover: impl FnMut(&str) -> Result<PathBuf, LocalBackendError>,
) -> Result<(ComposeProviderKind, PathBuf), LocalBackendError> {
    for (kind, name) in [
        (ComposeProviderKind::PodmanCompose, "podman-compose"),
        (ComposeProviderKind::DockerCompose, "docker-compose"),
    ] {
        if let Ok(path) = discover(name) {
            return Ok((kind, path));
        }
    }
    Err(problem("install podman-compose 1.5+ (Docker-free), or standalone docker-compose 2.24+, then retry local setup"))
}

impl ComposeProviderKind {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::DockerCompose => "docker-compose",
            Self::PodmanCompose => "podman-compose",
        }
    }

    pub(super) fn validate_version(self, version: &str) -> Result<(), LocalBackendError> {
        let parts = version
            .trim_start_matches('v')
            .split('.')
            .take(2)
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| problem(format!("{} returned an invalid version", self.name())))?;
        let minimum = match self {
            Self::DockerCompose => (2, 24),
            Self::PodmanCompose => (1, 5),
        };
        if parts.len() != 2 || (parts[0], parts[1]) < minimum {
            return Err(problem(format!(
                "install {} {}.{}+; Docker Engine is not required",
                self.name(),
                minimum.0,
                minimum.1
            )));
        }
        Ok(())
    }

    pub(super) fn arguments(self, args: Vec<OsString>, cli: &Path) -> Vec<OsString> {
        if self == Self::DockerCompose {
            return args;
        }
        // podman-compose calls this exact CLI. CONTAINER_HOST selects remote
        // mode at the saved socket. Its --podman-args are inserted after the
        // subcommand, where Podman's global --remote/--url flags are invalid.
        let mut result = vec![
            "--no-ansi".into(),
            "--podman-path".into(),
            cli.as_os_str().to_owned(),
        ];
        if args
            .windows(2)
            .any(|pair| pair[0] == "--pull" && pair[1] == "never")
        {
            result.push("--podman-run-args=--pull=never".into());
        }
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            if arg == "--ansi" || arg == "--project-directory" {
                args.next(); // Absolute --file and --env-file preserve the directory.
            } else if arg == "--pull" {
                // Native Podman defaults to pulling missing images. Updates pull
                // first, then force recreation with no further network pulls.
                if args.next().is_some_and(|policy| policy == "never") {
                    result.push("--force-recreate".into());
                }
            } else if arg == "--no-color" {
                // --no-ansi is global for podman-compose.
            } else if arg == "--no-TTY" {
                result.push("-T".into());
            } else {
                result.push(arg);
            }
        }
        result
    }
}
