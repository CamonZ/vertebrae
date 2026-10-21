//! Podman uses a pinned standalone Compose provider and an explicitly selected
//! local API socket. No Docker executable, machine lifecycle, or global defaults
//! are used to run a saved installation.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{ffi::OsString, path::PathBuf, time::Duration};

use super::command::{
    discover_container_tool, CommandOutput, CommandRequest, ProcessRunner, SystemProcessRunner,
};
use super::compose::{
    lifecycle::parse_service_statuses,
    transport::{redact_command_error, redact_seed_error, stack_request},
};
use super::runtime::{ContainerRuntime, DatabaseVolumeStatus, ServiceStatus, StartMode};
use super::state::{
    ApiToken, LocalBackendError, ManagedStackPaths, ManagedStackState, RuntimeKind, RuntimeSecrets,
    SeedAccount, StackKind,
};

mod target;
use target::{inspect_machine, inspect_store, resolve_target};

const QUICK: Duration = Duration::from_secs(30);
const RECONCILE: Duration = Duration::from_secs(15 * 60);
const REMOVE_ENV: &[&str] = &[
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_AUTH_CONFIG",
    "DOCKER_DEFAULT_PLATFORM",
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "CONTAINER_SSHKEY",
    "PODMAN_CONNECTIONS_CONF",
    "CONTAINERS_CONF",
    "CONTAINERS_CONF_OVERRIDE",
    "CONTAINERS_STORAGE_CONF",
    "STORAGE_DRIVER",
    "STORAGE_OPTS",
    "PODMAN_COMPOSE_PROVIDER",
    "COMPOSE_REMOVE_ORPHANS",
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_ENV_FILES",
    "COMPOSE_PATH_SEPARATOR",
    "COMPOSE_CONVERT_WINDOWS_PATHS",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodmanMachineTarget {
    pub name: String,
    pub connection: String,
    pub uri: String,
    pub identity: String,
    pub ssh_port: u16,
    pub user: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodmanTarget {
    pub endpoint: String,
    pub storage_root: String,
    pub provider: PathBuf,
    pub machine: Option<PodmanMachineTarget>,
}

impl PodmanTarget {
    pub fn validate(&self) -> Result<(), LocalBackendError> {
        let socket = self
            .endpoint
            .strip_prefix("unix://")
            .filter(|p| p.starts_with('/') && p.len() > 1);
        if socket.is_none() || !self.provider.is_absolute() || !self.storage_root.starts_with('/') {
            return Err(problem(
                "saved Podman socket, storage identity or Compose provider is invalid",
            ));
        }
        if let Some(machine) = &self.machine {
            if machine.name.is_empty()
                || machine.name.starts_with('-')
                || machine.connection.is_empty()
                || machine.ssh_port == 0
                || !PathBuf::from(&machine.identity).is_absolute()
            {
                return Err(problem("saved Podman machine identity is invalid"));
            }
        }
        Ok(())
    }
}

pub struct PodmanRuntime<R> {
    runner: R,
    cli: PathBuf,
    pub(super) target: PodmanTarget,
}

fn problem(message: impl Into<String>) -> LocalBackendError {
    LocalBackendError::Podman(message.into())
}

fn clean_request(
    program: &std::path::Path,
    action: &str,
    args: impl IntoIterator<Item = impl Into<OsString>>,
    timeout: Duration,
) -> CommandRequest {
    CommandRequest::new(action, program.as_os_str(), args, timeout)
        .with_env_removed(REMOVE_ENV.iter().copied())
}

impl PodmanRuntime<SystemProcessRunner> {
    pub async fn system() -> Result<Self, LocalBackendError> {
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err(problem(
                "GUI-managed Podman is supported on Linux and macOS only",
            ));
        }
        let cli = discover_container_tool("podman")?;
        let provider = discover_container_tool("docker-compose")?;
        let target = resolve_target(&SystemProcessRunner, &cli, provider).await?;
        let runtime = Self {
            runner: SystemProcessRunner,
            cli,
            target,
        };
        runtime.check_provider().await?;
        Ok(runtime)
    }

    pub fn system_for(target: PodmanTarget) -> Result<Self, LocalBackendError> {
        target.validate()?;
        if (cfg!(target_os = "macos") && target.machine.is_none())
            || (cfg!(target_os = "linux") && target.machine.is_some())
        {
            return Err(problem("saved Podman target does not match this operating system; restore its original runtime environment"));
        }
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err(problem(
                "GUI-managed Podman is supported on Linux and macOS only",
            ));
        }
        Ok(Self {
            runner: SystemProcessRunner,
            cli: discover_container_tool("podman")?,
            target,
        })
    }
}

impl<R: ProcessRunner> PodmanRuntime<R> {
    pub fn target(&self) -> &PodmanTarget {
        &self.target
    }

    fn native(
        &self,
        action: &str,
        args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> CommandRequest {
        let prefix = [
            OsString::from("--remote"),
            "--url".into(),
            self.target.endpoint.clone().into(),
        ];
        clean_request(
            &self.cli,
            action,
            prefix.into_iter().chain(args.into_iter().map(Into::into)),
            QUICK,
        )
    }

    fn compose(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        action: &str,
        operation: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> CommandRequest {
        let mut request = stack_request(
            |args| {
                clean_request(&self.target.provider, action, args, RECONCILE)
                    .with_env([("DOCKER_HOST", self.target.endpoint.as_str())])
            },
            paths,
            state,
            operation,
        )
        // Avoid short-name resolution and label the Linux bind mount for SELinux.
        .with_env([
            ("POSTGRES_IMAGE_REF", "docker.io/library/postgres:18-alpine"),
            (
                "SEED_MOUNT_OPTIONS",
                if cfg!(target_os = "linux") {
                    "ro,Z"
                } else {
                    "ro"
                },
            ),
        ]);
        // ProcessRunner removes env_remove after setting env. Keep this pinned
        // value while stripping inherited Docker targeting variables.
        request
            .env_remove
            .retain(|name| name != "DOCKER_HOST" && name != "SEED_MOUNT_OPTIONS");
        request
    }

    async fn checked(&self, request: CommandRequest) -> Result<CommandOutput, LocalBackendError> {
        checked(&self.runner, request).await
    }

    async fn stack(
        &self,
        request: CommandRequest,
        secrets: &RuntimeSecrets,
    ) -> Result<CommandOutput, LocalBackendError> {
        let output = self
            .checked(request)
            .await
            .map_err(|e| redact_command_error(e, secrets))?;
        // Redact only diagnostics; machine-readable fields must be parsed before redaction.
        Ok(output)
    }

    async fn check_provider(&self) -> Result<(), LocalBackendError> {
        let output = self
            .checked(clean_request(
                &self.target.provider,
                "check Podman Compose provider",
                ["version", "--short"],
                QUICK,
            ))
            .await?;
        require_complete(&output)?;
        let version = output.stdout.trim().trim_start_matches('v');
        let parts = version
            .split('.')
            .map(str::parse::<u64>)
            .take(2)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| problem("standalone Docker Compose returned an invalid version"))?;
        if parts.len() != 2 || parts[0] < 2 || (parts[0] == 2 && parts[1] < 24) {
            return Err(problem("install standalone Docker Compose 2.24+ (docker-compose); Docker Engine is not required"));
        }
        Ok(())
    }

    async fn verify_loopback(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<(), LocalBackendError> {
        let ids = self
            .stack(
                self.compose(
                    paths,
                    state,
                    "find Podman backend container",
                    ["ps", "--all", "--quiet", "sacrum"],
                ),
                secrets,
            )
            .await?;
        require_complete(&ids)?;
        let ids = ids.stdout.split_whitespace().collect::<Vec<_>>();
        if ids.len() != 1 || ids[0].starts_with('-') {
            return Err(problem("expected exactly one managed Sacrum container"));
        }
        let output = self
            .stack(
                self.native("verify Podman loopback publishing", ["inspect", ids[0]]),
                secrets,
            )
            .await?;
        let values: Vec<Value> = parse(&output)?;
        let bindings = values
            .first()
            .and_then(|v| v.pointer("/NetworkSettings/Ports/4000~1tcp"))
            .and_then(Value::as_array)
            .ok_or_else(|| problem("Podman did not report the backend's published port"))?;
        if bindings.is_empty()
            || bindings.iter().any(|v| {
                v["HostIp"].as_str() != Some("127.0.0.1")
                    || v["HostPort"].as_str() != Some(state.host_port.to_string().as_str())
            })
        {
            return Err(problem(
                "Podman backend publishing is not restricted to the saved loopback port",
            ));
        }
        Ok(())
    }
}

async fn checked<R: ProcessRunner>(
    runner: &R,
    request: CommandRequest,
) -> Result<CommandOutput, LocalBackendError> {
    let action = request.action.clone();
    let output = runner.run(request).await?;
    if !output.success {
        return Err(LocalBackendError::CommandFailed {
            action,
            status: output
                .exit_code
                .map(|v| v.to_string())
                .unwrap_or_else(|| "terminated".into()),
            output: output.summary(),
        });
    }
    Ok(output)
}

fn parse<T: serde::de::DeserializeOwned>(output: &CommandOutput) -> Result<T, LocalBackendError> {
    require_complete(output)?;
    serde_json::from_str(&output.stdout)
        .map_err(|e| problem(format!("invalid Podman inspection output: {e}")))
}

fn require_complete(output: &CommandOutput) -> Result<(), LocalBackendError> {
    if output.truncated {
        Err(problem(
            "Podman inspection output exceeded the capture limit",
        ))
    } else {
        Ok(())
    }
}

#[async_trait]
impl<R: ProcessRunner> ContainerRuntime for PodmanRuntime<R> {
    async fn revalidate_target(&self) -> Result<(), LocalBackendError> {
        self.target.validate()?;
        if let Some(machine) = &self.target.machine {
            let current = inspect_machine(&self.runner, &self.cli, &machine.connection).await?;
            if current.0 != self.target.endpoint || &current.1 != machine {
                return Err(problem(
                    "saved Podman machine/connection changed; restore it before retrying",
                ));
            }
        }
        let output = self
            .checked(self.native(
                "verify Podman storage identity",
                ["info", "--format", "json"],
            ))
            .await?;
        let root = inspect_store(&parse::<Value>(&output)?)?;
        if root != self.target.storage_root {
            return Err(problem(
                "saved Podman rootless storage identity changed; existing data was left untouched",
            ));
        }
        Ok(())
    }

    fn validate_stack_files(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        state.validate()?;
        if state.runtime != RuntimeKind::Podman
            || state.podman_target.as_ref() != Some(&self.target)
        {
            return Err(problem(
                "saved backend belongs to a different Podman target or runtime",
            ));
        }
        for path in [&paths.compose_file, &paths.seed_file, &paths.secrets_file] {
            if !path.is_file() {
                return Err(problem(
                    "managed backend files are missing; restore them before retrying",
                ));
            }
        }
        paths.load_runtime_secrets(state.kind)
    }

    async fn prepare_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        mode: StartMode,
    ) -> Result<RuntimeSecrets, LocalBackendError> {
        if mode != StartMode::Reconcile || state.kind != StackKind::Managed {
            return Err(problem("legacy Docker adoption cannot use Podman"));
        }
        self.revalidate_target().await?;
        self.check_provider().await?;
        self.validate_stack_files(paths, state)
    }

    async fn inspect_database_volume(
        &self,
        state: &ManagedStackState,
    ) -> Result<DatabaseVolumeStatus, LocalBackendError> {
        let name = state.postgres_volume();
        if !self.database_volume_exists(&name).await? {
            return Ok(DatabaseVolumeStatus::Absent);
        }
        let output = self
            .checked(self.native(
                "inspect Podman database volume",
                ["volume", "inspect", &name],
            ))
            .await?;
        let values: Vec<Value> = parse(&output)?;
        let expected_project = state.project_name();
        let valid = values.len() == 1
            && values[0]["Name"].as_str() == Some(name.as_str())
            && values[0]
                .pointer("/Labels/com.docker.compose.project")
                .and_then(Value::as_str)
                == Some(expected_project.as_str())
            && values[0]
                .pointer("/Labels/com.docker.compose.volume")
                .and_then(Value::as_str)
                == Some("pgdata");
        Ok(if valid {
            DatabaseVolumeStatus::Present
        } else {
            DatabaseVolumeStatus::Unsafe(
                "Podman database volume has unexpected ownership metadata".into(),
            )
        })
    }

    async fn start_services(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
        _: StartMode,
    ) -> Result<(), LocalBackendError> {
        self.stack(
            self.compose(
                paths,
                state,
                "validate Podman Compose configuration",
                ["config", "--quiet"],
            ),
            secrets,
        )
        .await?;
        self.stack(
            self.compose(
                paths,
                state,
                "start Podman backend",
                ["up", "--detach", "--pull", "missing", "postgres", "sacrum"],
            ),
            secrets,
        )
        .await
        .map_err(|error| match error {
            LocalBackendError::CommandFailed { ref output, .. }
                if output.to_lowercase().contains("address already in use")
                    || output.to_lowercase().contains("port is already allocated") =>
            {
                LocalBackendError::PortUnavailable {
                    port: state.host_port,
                    output: output.clone(),
                }
            }
            error => error,
        })?;
        if let Err(error) = self.verify_loopback(paths, state, secrets).await {
            self.stack(
                self.compose(
                    paths,
                    state,
                    "stop unsafe Podman backend publication",
                    ["stop", "sacrum"],
                ),
                secrets,
            )
            .await?;
            return Err(error);
        }
        Ok(())
    }

    async fn database_volume_exists(&self, name: &str) -> Result<bool, LocalBackendError> {
        let output = self
            .checked(self.native(
                "find Podman database volume",
                [
                    "volume",
                    "ls",
                    "--filter",
                    &format!("name={name}"),
                    "--format",
                    "{{.Name}}",
                ],
            ))
            .await?;
        require_complete(&output)?;
        Ok(output.stdout.lines().any(|v| v.trim() == name))
    }

    async fn status(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        self.revalidate_target().await?;
        let secrets = self.validate_stack_files(paths, state)?;
        self.status_after_start(paths, state, &secrets).await
    }
    async fn status_after_start(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<Vec<ServiceStatus>, LocalBackendError> {
        let output = self
            .stack(
                self.compose(
                    paths,
                    state,
                    "read Podman backend status",
                    ["ps", "--format", "json"],
                ),
                secrets,
            )
            .await?;
        require_complete(&output)?;
        parse_service_statuses(&output.stdout)
    }
    async fn run_seeder(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        account: &SeedAccount,
        token: &ApiToken,
    ) -> Result<(), LocalBackendError> {
        self.revalidate_target().await?;
        let secrets = self.validate_stack_files(paths, state)?;
        let request = self
            .compose(
                paths,
                state,
                "seed Podman backend account",
                ["run", "--rm", "--no-deps", "seeder"],
            )
            .with_env([
                ("SEED_EMAIL", account.email()),
                ("SEED_USERNAME", account.username()),
                ("SEED_PASSWORD", account.password()),
                ("SEED_TOKEN", token.as_str()),
            ]);
        self.stack(request, &secrets)
            .await
            .map(|_| ())
            .map_err(|e| redact_seed_error(e, account, token))
    }
    async fn replace_sacrum_image(
        &self,
        paths: &ManagedStackPaths,
        current: &ManagedStackState,
        updated: &ManagedStackState,
    ) -> Result<(), LocalBackendError> {
        self.revalidate_target().await?;
        self.check_provider().await?;
        let secrets = self.validate_stack_files(paths, current)?;
        self.inspect_database_volume(current).await.and_then(|status| match status {
            DatabaseVolumeStatus::Present => Ok(()), _ => Err(problem("database volume is missing or has unexpected metadata; restore it before updating"))
        })?;
        self.stack(
            self.compose(
                paths,
                updated,
                "pull Podman backend image",
                ["pull", "sacrum"],
            ),
            &secrets,
        )
        .await?;
        self.stack(
            self.compose(
                paths,
                updated,
                "recreate Podman backend service",
                ["up", "--detach", "--no-deps", "--pull", "never", "sacrum"],
            ),
            &secrets,
        )
        .await?;
        if let Err(error) = self.verify_loopback(paths, updated, &secrets).await {
            self.stack(
                self.compose(
                    paths,
                    updated,
                    "stop unsafe Podman backend publication",
                    ["stop", "sacrum"],
                ),
                &secrets,
            )
            .await?;
            return Err(error);
        }
        Ok(())
    }
    async fn logs(
        &self,
        paths: &ManagedStackPaths,
        state: &ManagedStackState,
        secrets: &RuntimeSecrets,
    ) -> Result<String, LocalBackendError> {
        self.revalidate_target().await?;
        let output = self
            .stack(
                self.compose(
                    paths,
                    state,
                    "read Podman backend logs",
                    ["logs", "--no-color", "--tail", "80", "postgres", "sacrum"],
                ),
                secrets,
            )
            .await?;
        Ok(secrets.redact(&output.summary()))
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod smoke;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests;
